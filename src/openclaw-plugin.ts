/**
 * PimClaw OpenClaw Plugin — v2 Minimal Hybrid Architecture
 *
 * Integrates with OpenClaw via:
 *   - definePluginEntry()   — plugin registration
 *   - api.registerService() — lifecycle-managed background service that
 *     boots the PimClaw Components (TaskStatusRecorder, Scheduler, AnomalyReceiver)
 *   - api.registerTool()    — exposes PimClaw tools to OpenClaw agents
 *
 * The LLM Head and Planner agents run externally via OpenClaw's agent runtime,
 * not inside this plugin. They interact through two integration gates:
 *   - pimclaw_submit_anomalies (Head → Plugin)
 *   - pimclaw_plan_task (Planner → Plugin)
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { execFile } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'node:util';
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import { ComponentRegistry } from './master/component-registry.js';
import { TaskStatusRecorder } from './master/task-status-recorder.js';
import { SchedulerAgent } from './master/scheduler-agent.js';
import { AnomalyReceiver } from './master/anomaly-receiver.js';
import type { AnomalyEvent } from './master/anomaly-receiver.js';
import { PlannerTrigger } from './master/planner-trigger.js';
import type { OpenClawAgentApi } from './master/planner-trigger.js';
import {
  PrometheusClient,
  vllmPromQLMap,
  injectLabels,
} from './master/prometheus-client.js';
import type { PrometheusClientOptions } from './master/prometheus-client.js';
import type { Task } from './types/index.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Tool hook governance ──────────────────────────────────────────────────

/**
 * Hook interface for tool execution governance.
 * All hooks are non-fatal — errors are caught and logged, never kill tool execution.
 */
export interface ToolHook {
  preToolUse?(toolName: string, params: Record<string, unknown>): Promise<{
    updatedInput?: Record<string, unknown>;
    blockingError?: string;
  } | void>;
  postToolUse?(toolName: string, result: unknown, durationMs: number): Promise<void>;
  postToolUseFailure?(toolName: string, error: unknown, durationMs: number): Promise<void>;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (sessionId: string, params: Record<string, unknown>) => Promise<{ output: string }>;
}

/**
 * Wrap a tool definition with hook governance.
 * Hooks run before/after tool execution but never block the pipeline on failure.
 */
function withHooks(tool: ToolDefinition, hooks: ToolHook[]): ToolDefinition {
  if (hooks.length === 0) return tool;

  const originalExecute = tool.execute;
  tool.execute = async (sessionId: string, params: Record<string, unknown>) => {
    // Pre hooks
    let effectiveParams = params;
    for (const hook of hooks) {
      try {
        const pre = await hook.preToolUse?.(tool.name, effectiveParams);
        if (pre?.blockingError) {
          return { output: JSON.stringify({ error: pre.blockingError }) };
        }
        if (pre?.updatedInput) {
          effectiveParams = pre.updatedInput;
        }
      } catch {
        // Non-fatal: skip this hook
      }
    }

    const start = Date.now();
    try {
      const result = await originalExecute(sessionId, effectiveParams);
      const duration = Date.now() - start;

      // Post hooks (non-fatal)
      for (const hook of hooks) {
        try { await hook.postToolUse?.(tool.name, result, duration); } catch { /* non-fatal */ }
      }

      return result;
    } catch (err) {
      const duration = Date.now() - start;

      // Failure hooks (non-fatal)
      for (const hook of hooks) {
        try { await hook.postToolUseFailure?.(tool.name, err, duration); } catch { /* non-fatal */ }
      }

      throw err;
    }
  };
  return tool;
}

// ─── Shared state across the plugin (lives for the OpenClaw process) ───────

let registry: ComponentRegistry | null = null;
let taskRecorder: TaskStatusRecorder | null = null;
let scheduler: SchedulerAgent | null = null;
let anomalyReceiver: AnomalyReceiver | null = null;
let prometheusClient: PrometheusClient | null = null;
let prometheusQueryOverrides: Record<string, string> = {};
let prometheusDefaultLabels: Record<string, string> = {};
let pluginRuntime: unknown = null;
let plannerFallbackTaskType: 'scale-up' | 'scale-down' | 'restart' | 'reconfigure' = 'scale-up';
let plannerFallbackConfig: Record<string, unknown> = { replicaDelta: 1 };
let planningTimeoutMs = 600_000;
let pluginLogger: OpenClawPluginServiceContext['logger'] | null = null;
const planningFallbackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const toolHooks: ToolHook[] = [];
const execFileAsync = promisify(execFile);

interface PlannerSubmission {
  taskId: string;
  taskType: string;
  config: Record<string, unknown>;
  reasoning: string;
  perfEvidence?: string;
  simulationResults?: string;
}

async function applyPlannerSubmission(submission: PlannerSubmission): Promise<{ success: true; taskId: string; message: string } | { error: string }> {
  if (!taskRecorder) {
    return { error: 'PimClaw service not running' };
  }

  const task = taskRecorder.getTask(submission.taskId);
  if (!task) {
    return { error: `Task ${submission.taskId} not found` };
  }

  if (task.status !== 'planning') {
    return { error: `Task ${submission.taskId} is in '${task.status}' state, expected 'planning'` };
  }

  task.taskType = submission.taskType;
  task.config = submission.config;
  task.reasoning = submission.reasoning;
  task.perfEvidence = submission.perfEvidence;
  task.simulationResults = submission.simulationResults;

  clearPlanningFallback(submission.taskId);
  await taskRecorder.updateTaskStatus(submission.taskId, 'ready');

  return {
    success: true,
    taskId: submission.taskId,
    message: `Task ${submission.taskId} planned and ready for scheduling`,
  };
}

function createCliPlannerAgentApi(ctx: OpenClawPluginServiceContext): OpenClawAgentApi {
  return {
    async triggerAgent(agentId, options) {
      const plannerInstruction = [
        options.task,
        'Return only valid JSON with this exact schema:',
        JSON.stringify({
          taskId: 'string',
          taskType: 'scale-up | scale-down | restart | reconfigure',
          config: {
            replicas: 'number',
            dtype: 'string',
            quantization: 'string|null',
            maxBatchSize: 'number',
            tensorParallelism: 'number',
          },
          reasoning: 'string',
          perfEvidence: 'string',
          simulationResults: 'string',
        }),
        'Do not wrap the JSON in markdown fences.',
      ].join('\n\n');

      const { stdout, stderr } = await execFileAsync(
        'openclaw',
        [
          'agent',
          '--agent', agentId,
          '--message', plannerInstruction,
          '--timeout', String(options.runTimeoutSeconds),
          '--json',
        ],
        {
          cwd: options.workspaceDir ?? ctx.workspaceDir,
          env: process.env,
          timeout: options.runTimeoutSeconds * 1000,
        },
      );

      if (stderr.trim()) {
        ctx.logger.warn(`[PimClaw] Planner CLI stderr: ${stderr.trim()}`);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        ctx.logger.info(`[PimClaw] Planner CLI raw output: ${stdout.trim()}`);
        return;
      }

      if (parsed?.status && parsed.status !== 'ok') {
        throw new Error(`planner CLI run failed: ${parsed.status}`);
      }

      const plannerText = parsed?.result?.payloads?.map((payload: any) => payload?.text ?? '').join('\n').trim();
      if (!plannerText) {
        throw new Error('planner CLI returned no text payload');
      }

      let submission: PlannerSubmission;
      try {
        submission = JSON.parse(plannerText);
      } catch (error) {
        throw new Error(`planner CLI did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }

      const applied = await applyPlannerSubmission(submission);
      if ('error' in applied) {
        throw new Error(applied.error);
      }
    },
  };
}

function clearPlanningFallback(taskId: string): void {
  const timer = planningFallbackTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    planningFallbackTimers.delete(taskId);
  }
}

async function applyFallbackPlan(taskId: string, reason: string): Promise<boolean> {
  if (!taskRecorder) {
    return false;
  }

  const task = taskRecorder.getTask(taskId);
  if (!task || task.status !== 'planning') {
    return false;
  }

  task.taskType = plannerFallbackTaskType;
  task.config = { ...plannerFallbackConfig };
  task.reasoning = `Fallback plan applied: ${reason}`;
  task.perfEvidence = 'Fallback mode: Planner timed out or failed before submitting plan';
  task.simulationResults = 'No simulation available in fallback mode';

  await taskRecorder.updateTaskStatus(taskId, 'ready');
  clearPlanningFallback(taskId);
  pluginLogger?.warn(`[PimClaw] Applied fallback plan to task ${taskId}: ${reason}`);

  return true;
}

function schedulePlanningFallback(taskId: string): void {
  clearPlanningFallback(taskId);
  const timer = setTimeout(() => {
    void applyFallbackPlan(taskId, `planner timeout after ${planningTimeoutMs}ms`);
  }, planningTimeoutMs);
  planningFallbackTimers.set(taskId, timer);
}

/**
 * Register a tool hook for governance.
 * Hooks are applied to all 10 PimClaw tools and are non-fatal.
 */
export function registerToolHook(hook: ToolHook): void {
  toolHooks.push(hook);
}

// ─── Service: lifecycle-managed PimClaw components ─────────────────────────

function createPimClawService(): OpenClawPluginService {
  return {
    id: 'pimclaw-components',

    async start(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info('[PimClaw] Starting components…');
      pluginLogger = ctx.logger;

      // 1. Shared infrastructure
      registry = new ComponentRegistry();
      taskRecorder = new TaskStatusRecorder(
        `${ctx.stateDir}/pimclaw-tasks`,
      );
      await taskRecorder.initialize();

      const agentWorkspaceRoot = path.join(ctx.workspaceDir, '.pimclaw-agents');
      const headWorkspaceDir = path.join(agentWorkspaceRoot, 'head');
      const plannerConfig = (ctx.config as any)?.planner ?? {};
      const plannerWorkspaceDir = plannerConfig.workspaceDir ?? path.join(agentWorkspaceRoot, 'planner');

      await fs.mkdir(headWorkspaceDir, { recursive: true });
      await fs.mkdir(plannerWorkspaceDir, { recursive: true });

      // 2. PlannerTrigger — spawns Planner agent via OpenClaw API
      plannerFallbackTaskType = plannerConfig.fallbackTaskType ?? 'scale-up';
      plannerFallbackConfig = plannerConfig.fallbackConfig ?? { replicaDelta: 1 };
      const openclawApi = (ctx as any).openclawApi ?? createCliPlannerAgentApi(ctx);
      if (!(ctx as any).openclawApi) {
        ctx.logger.info('[PimClaw] Using CLI-based planner trigger fallback');
      }
      const plannerTrigger = new PlannerTrigger(openclawApi, {
        agentId: plannerConfig.agentId ?? 'pimclaw-planner',
        timeoutSeconds: plannerConfig.timeoutSeconds ?? 600,
        workspaceDir: plannerWorkspaceDir,
      });

      ctx.logger.info(
        `[PimClaw] Dedicated agent workspaces ready: head=${headWorkspaceDir}, planner=${plannerWorkspaceDir}`,
      );

      // 3. AnomalyReceiver — validates events from LLM Head, triggers Planner
      const receiverConfig = (ctx.config as any)?.anomalyReceiver ?? {};
      planningTimeoutMs = receiverConfig.planningTimeoutMs ?? 600_000;
      anomalyReceiver = new AnomalyReceiver(
        taskRecorder,
        plannerTrigger,
        receiverConfig,
        {
          onPlanningTaskCreated: async (taskId) => {
            schedulePlanningFallback(taskId);
          },
          onPlannerTriggerFailed: async (taskId, _event, error) => {
            const message = error instanceof Error ? error.message : String(error);
            await applyFallbackPlan(taskId, `planner trigger failed: ${message}`);
          },
        },
      );

      // 4. Scheduler — polls for ready tasks, spawns Workers
      scheduler = new SchedulerAgent(registry, taskRecorder);
      await scheduler.initialize();
      scheduler.run().catch((err) =>
        ctx.logger.error(`[PimClaw] Scheduler error: ${err}`),
      );

      // 5. PrometheusClient — for pimclaw_query_metrics tool
      const promCfg = (ctx.config as any)?.prometheus;
      if (promCfg?.baseUrl) {
        prometheusClient = new PrometheusClient({
          baseUrl: promCfg.baseUrl,
          timeoutMs: promCfg.timeoutMs,
          username: promCfg.username,
          password: promCfg.password,
          bearerToken: promCfg.bearerToken,
        });
        prometheusQueryOverrides = promCfg.queryOverrides ?? {};
        prometheusDefaultLabels = promCfg.defaultLabels ?? {};
        ctx.logger.info(`[PimClaw] Prometheus client configured → ${promCfg.baseUrl}`);
      } else {
        ctx.logger.warn('[PimClaw] No prometheus.baseUrl configured — pimclaw_query_metrics will be unavailable');
      }

      ctx.logger.info(
        '[PimClaw] Components started (TaskRecorder → AnomalyReceiver → Scheduler)',
      );
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info('[PimClaw] Stopping components…');

      if (scheduler) {
        await scheduler.shutdown();
        scheduler = null;
      }
      anomalyReceiver = null;
      for (const taskId of planningFallbackTimers.keys()) {
        clearPlanningFallback(taskId);
      }
      if (taskRecorder) {
        await taskRecorder.persist();
        taskRecorder = null;
      }
      registry = null;
      prometheusClient = null;
      prometheusQueryOverrides = {};
      prometheusDefaultLabels = {};
      pluginRuntime = null;
      pluginLogger = null;
      toolHooks.length = 0;

      ctx.logger.info('[PimClaw] All components stopped');
    },
  };
}

// ─── Tool builders ─────────────────────────────────────────────────────────

function buildPimClawTools() {
  // ── Prometheus Metrics Tool (Phase 1, Step 3) ──────────────────────────
  const queryMetricsTool = () => ({
    name: 'pimclaw_query_metrics',
    description:
      'Query Prometheus for vLLM metrics (TTFT, TPOT, QPS, throughput, GPU utilization, error rate). Called by the Head Agent for anomaly detection.',
    parameters: {
      type: 'object' as const,
      properties: {
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Which metrics to fetch. Options: ttft, tpot, qps, throughput, gpu_utilization, error_rate. Default: all.',
        },
        deploymentName: {
          type: 'string',
          description: 'vLLM model_name label to filter by',
        },
        rangeMinutes: {
          type: 'number',
          description: 'If set, return time-series range data for trend detection instead of an instant value',
        },
      },
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!prometheusClient) {
        return {
          output: JSON.stringify({
            error: 'Prometheus not configured. Set prometheus.baseUrl in plugin config.',
          }),
        };
      }

      const requestedMetrics = (params.metrics as string[] | undefined) ?? Object.keys(vllmPromQLMap);
      const deploymentName = params.deploymentName as string | undefined;
      const rangeMinutes = params.rangeMinutes as number | undefined;
      const nowSec = Math.floor(Date.now() / 1000);

      const results: Record<string, unknown> = {};

      for (const metric of requestedMetrics) {
        // Resolve PromQL: config override > default vLLM map
        let promql = prometheusQueryOverrides[metric] ?? vllmPromQLMap[metric];
        if (!promql) {
          results[metric] = { error: `Unknown metric: ${metric}` };
          continue;
        }

        // Inject labels (deploymentName + defaultLabels from config)
        const labels: Record<string, string> = { ...prometheusDefaultLabels };
        if (deploymentName) {
          labels['model_name'] = deploymentName;
        }
        promql = injectLabels(promql, labels);

        try {
          if (rangeMinutes) {
            const start = nowSec - rangeMinutes * 60;
            const step = Math.max(15, Math.floor((rangeMinutes * 60) / 20));
            results[metric] = await prometheusClient.queryRange(promql, start, nowSec, step);
          } else {
            results[metric] = await prometheusClient.query(promql);
          }
        } catch (err) {
          results[metric] = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      return { output: JSON.stringify(results) };
    },
  });

  // ── Gate 1: LLM Head Agent → Plugin ──────────────────────────────────────

  const submitAnomaliesTool = () => ({
    name: 'pimclaw_submit_anomalies',
    description:
      'Submit detected anomaly events for task planning. Called by the PimClaw Head Agent after analyzing Grafana metrics.',
    parameters: {
      type: 'object' as const,
      properties: {
        events: {
          type: 'array',
          description: 'Array of anomaly events detected by the Head Agent',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['spike', 'drop', 'trend', 'anomaly'] },
              metricName: { type: 'string' },
              currentValue: { type: 'number' },
              previousValue: { type: 'number' },
              severity: { type: 'string', enum: ['high', 'medium', 'low'] },
              deploymentName: { type: 'string' },
              reasoning: { type: 'string' },
            },
            required: ['type', 'metricName', 'currentValue', 'severity', 'deploymentName'],
          },
        },
      },
      required: ['events'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!anomalyReceiver) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      try {
        const events = params.events as AnomalyEvent[];
        const validated = await anomalyReceiver.receive(events);
        return {
          output: JSON.stringify({
            success: true,
            accepted: validated.length,
            tasks: validated.map((e) => ({ taskId: e.taskId, eventId: e.eventId })),
          }),
        };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  // ── Gate 2: LLM Planner Agent → Plugin ───────────────────────────────────

  const planTaskTool = () => ({
    name: 'pimclaw_plan_task',
    description:
      'Submit a deployment configuration plan for a task in planning state. Called by the PimClaw Planner Agent after analyzing perf data and simulation results.',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'The task ID to attach the plan to' },
        taskType: {
          type: 'string',
          enum: ['scale-up', 'scale-down', 'restart', 'reconfigure'],
          description: 'Type of deployment change',
        },
        config: {
          type: 'object',
          description: 'Deployment configuration to apply',
          properties: {
            replicas: { type: 'number' },
            dtype: { type: 'string' },
            quantization: { type: 'string' },
            maxBatchSize: { type: 'number' },
            tensorParallelism: { type: 'number' },
          },
        },
        reasoning: { type: 'string', description: 'Why this config was selected' },
        perfEvidence: { type: 'string', description: 'Historical perf data supporting this choice' },
        simulationResults: { type: 'string', description: 'Simulation predictions for this config' },
      },
      required: ['taskId', 'taskType', 'config', 'reasoning'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      try {
        const result = await applyPlannerSubmission({
          taskId: params.taskId as string,
          taskType: params.taskType as string,
          config: params.config as Record<string, unknown>,
          reasoning: params.reasoning as string,
          perfEvidence: params.perfEvidence as string | undefined,
          simulationResults: params.simulationResults as string | undefined,
        });

        return { output: JSON.stringify(result) };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  // ── Existing tools ───────────────────────────────────────────────────────

  const routeTaskTool = () => ({
    name: 'pimclaw_route_task',
    description:
      'Submit a task directly to PimClaw (bypasses Head/Planner). The Scheduler picks it up and creates a Worker.',
    parameters: {
      type: 'object' as const,
      properties: {
        llmDeploymentName: {
          type: 'string',
          description: 'Target LLM deployment name',
        },
        taskType: {
          type: 'string',
          description: 'Task type (scale-up, scale-down, restart, etc.)',
        },
        priority: {
          type: 'string',
          description: 'Priority (low, medium, high). Defaults to medium.',
        },
        taskData: {
          type: 'object',
          description: 'Arbitrary task payload',
        },
      },
      required: ['llmDeploymentName', 'taskType'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const task: Task = {
        taskId: uuidv4(),
        status: 'ready',
        createdAt: new Date(),
        statusModifiedAt: new Date(),
        priority: (params.priority as Task['priority']) || 'medium',
        llmDeploymentName: params.llmDeploymentName as string,
        taskType: params.taskType as string,
        taskData: (params.taskData as Record<string, unknown>) || {},
        retryCount: 0,
        maxRetries: 3,
      };
      await taskRecorder.createTask(task);
      return {
        output: JSON.stringify({
          success: true,
          taskId: task.taskId,
          message: `Task routed to scheduler for ${task.llmDeploymentName}`,
        }),
      };
    },
  });

  const listComponentsTool = () => ({
    name: 'pimclaw_list_components',
    description: 'List all active PimClaw components (Scheduler, Task Status Recorder, Workers) and their runtime status.',
    parameters: {
      type: 'object' as const,
      properties: {
        componentType: {
          type: 'string',
          description: 'Filter by type (scheduler, recorder, worker)',
        },
      },
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const components = registry.getAllAgentsStatus();
      const filtered = params.componentType
        ? components.filter((a) => a.agentType === params.componentType)
        : components;
      return { output: JSON.stringify(filtered) };
    },
  });

  const componentStatusTool = () => ({
    name: 'pimclaw_component_status',
    description: 'Get detailed runtime status of a specific PimClaw component.',
    parameters: {
      type: 'object' as const,
      properties: {
        componentId: { type: 'string', description: 'Component ID' },
      },
      required: ['componentId'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const status = registry.getAgentStatus(params.componentId as string);
      return { output: JSON.stringify(status ?? { error: 'Component not found' }) };
    },
  });

  const healthTool = () => ({
    name: 'pimclaw_health',
    description:
      'Get the overall PimClaw health report including component status and detected issues.',
    parameters: { type: 'object' as const, properties: {} },
    async execute() {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      return { output: JSON.stringify(registry.getHealthReport()) };
    },
  });

  const taskCountsTool = () => ({
    name: 'pimclaw_task_counts',
    description: 'Get counts of PimClaw tasks grouped by status.',
    parameters: { type: 'object' as const, properties: {} },
    async execute() {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      return { output: JSON.stringify(taskRecorder.getTaskCounts()) };
    },
  });

  const listTasksTool = () => ({
    name: 'pimclaw_list_tasks',
    description: 'List PimClaw tasks, optionally filtered by status.',
    parameters: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description:
            'Filter by status (planning, ready, scheduling, scheduled, running, done, failed, expired)',
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const limit = (params.limit as number) || 20;
      const tasks = params.status
        ? taskRecorder.getTasksByStatus(params.status as any)
        : taskRecorder.getAllTasks();
      return { output: JSON.stringify(tasks.slice(0, limit)) };
    },
  });

  const retryTaskTool = () => ({
    name: 'pimclaw_retry_task',
    description: 'Reset a failed PimClaw task so the Scheduler retries it.',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to retry' },
      },
      required: ['taskId'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      try {
        await taskRecorder.resetTaskForRetry(params.taskId as string);
        return { output: JSON.stringify({ success: true, taskId: params.taskId }) };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  const revokeTaskTool = () => ({
    name: 'pimclaw_revoke_task',
    description: 'Cancel a pending PimClaw task by marking it expired.',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to revoke' },
      },
      required: ['taskId'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!taskRecorder) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      try {
        await taskRecorder.updateTaskStatus(params.taskId as string, 'expired');
        return { output: JSON.stringify({ success: true, taskId: params.taskId }) };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  return [
    submitAnomaliesTool,
    planTaskTool,
    routeTaskTool,
    queryMetricsTool,
    listComponentsTool,
    componentStatusTool,
    healthTool,
    taskCountsTool,
    listTasksTool,
    retryTaskTool,
    revokeTaskTool,
  ];
}

// ─── Plugin entry ──────────────────────────────────────────────────────────

export default definePluginEntry({
  id: 'pimclaw',
  name: 'PimClaw',
  description:
    'LLM deployment orchestration — monitors metrics via LLM Head Agent, plans configs via LLM Planner Agent, and executes changes via programmatic Scheduler/Workers.',

  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;
    api.registerService(createPimClawService());

    for (const toolFactory of buildPimClawTools()) {
      // Wrap each tool factory with hook governance
      const wrappedFactory = () => {
        const tool = toolFactory();
        return withHooks(tool as ToolDefinition, toolHooks);
      };
      api.registerTool(wrappedFactory);
    }

    api.logger.info('[PimClaw] Plugin registered (v2 hybrid architecture)');
  },
});
