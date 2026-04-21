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
import { FileLogger } from './master/file-logger.js';
import {
  PrometheusClient,
  injectLabels,
  getPromQLMap,
  parseEngineConfig,
  allMetricNames,
  ALL_ENGINES,
} from './master/prometheus-client.js';
import type { InferenceEngine, PrometheusQueryMap } from './master/prometheus-client.js';
import { MetricsStore, extractMetricValue, DeploymentMetrics } from './master/metrics-store.js';
import {
  HeadSummaryStore,
  type HeadMonitoringAnomalyRow,
  type HeadMonitoringDeploymentSummary,
  type HeadMonitoringSummaryRecord,
  type SummaryMetricName,
} from './master/head-summary-store.js';
import { EngineMcpClient } from './master/engine-mcp-client.js';
import type { EngineMcpConfig } from './master/engine-mcp-client.js';
import { PerfMcpClient } from './master/perf-mcp-client.js';
import type { PerfMcpConfig } from './master/perf-mcp-client.js';
import { SimMcpClient } from './master/sim-mcp-client.js';
import type { SimMcpConfig } from './master/sim-mcp-client.js';
import { TaskExecutor } from './master/task-executor.js';
import type { Task } from './types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { selectPlannerAgentApi } from './master/planner-launch.js';

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
let engineMcpClient: EngineMcpClient | null = null;
let perfMcpClient: PerfMcpClient | null = null;
let simMcpClient: SimMcpClient | null = null;
let taskExecutor: TaskExecutor | null = null;
let prometheusQueryOverrides: Record<string, string> = {};
let prometheusDefaultLabels: Record<string, string> = {};
let activeEngines: InferenceEngine[] = [...ALL_ENGINES];
let metricsStore: MetricsStore | null = null;
let headSummaryStore: HeadSummaryStore | null = null;
let pluginConfig: Record<string, unknown> = {};
let pluginRuntime: unknown = null;
let plannerFallbackTaskType: 'scale-up' | 'scale-down' | 'restart' | 'reconfigure' = 'scale-up';
let plannerFallbackConfig: Record<string, unknown> = { replicaDelta: 1 };
let planningTimeoutMs = 600_000;
let pluginLogger: OpenClawPluginServiceContext['logger'] | null = null;
let fileLogger: FileLogger | null = null;
const planningFallbackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const currentHeadRunIds: Map<string, string> = new Map();
const toolHooks: ToolHook[] = [];
const execFileAsync = promisify(execFile);
const summaryMetrics: SummaryMetricName[] = [
  'ttft',
  'tpot',
  'qps',
  'throughput',
  'gpu_utilization',
  'error_rate',
];

function normalizeMetricNumber(value: number | null): number | null {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function extractSummaryMetricValue(result: unknown): number | null {
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  const first = result[0] as any;
  if (first?.value) {
    return normalizeMetricNumber(parseFloat(first.value[1]));
  }

  if (!Array.isArray(first?.values) || first.values.length === 0) {
    return null;
  }

  const numericValues = first.values
    .map((entry: [number, string]) => parseFloat(entry[1]))
    .filter((value: number) => Number.isFinite(value));

  if (numericValues.length === 0) {
    return null;
  }

  const total = numericValues.reduce((sum: number, value: number) => sum + value, 0);
  return total / numericValues.length;
}

function collectDeploymentNames(
  engineResults: Record<string, unknown>,
  metrics: readonly string[],
): string[] {
  const deploymentNames = new Set<string>();
  for (const metric of metrics) {
    const results = engineResults[metric] as any[];
    if (!Array.isArray(results)) {
      continue;
    }
    for (const result of results) {
      if (typeof result?.metric?.model_name === 'string') {
        deploymentNames.add(result.metric.model_name);
      }
    }
  }
  return Array.from(deploymentNames).sort();
}

function getDeploymentMetricResult(
  engineResults: Record<string, unknown>,
  metric: string,
  deploymentName: string,
): unknown {
  const results = engineResults[metric] as any[];
  if (!Array.isArray(results)) {
    return null;
  }
  const match = results.find((result) => result?.metric?.model_name === deploymentName);
  return match ? [match] : null;
}

function createDeploymentSummary(
  deploymentName: string,
  engine: string,
  engineResults: Record<string, unknown>,
  store: HeadSummaryStore,
  runId: string,
): HeadMonitoringDeploymentSummary {
  return {
    deploymentName,
    engine,
    metricTable: summaryMetrics.map((metric) => ({
      metric,
      currentValue: extractSummaryMetricValue(getDeploymentMetricResult(engineResults, metric, deploymentName)),
      priorValue: store.findPreviousMetricValue(deploymentName, engine, metric, runId),
    })),
    anomalyTable: [],
  };
}

function buildHeadSummaryRecord(
  sessionId: string,
  grouped: Record<string, Record<string, unknown>>,
  engines: InferenceEngine[],
  runId: string,
  store: HeadSummaryStore,
): HeadMonitoringSummaryRecord {
  const deployments: HeadMonitoringDeploymentSummary[] = [];

  for (const engine of engines) {
    const engineResults = grouped[engine];
    if (!engineResults) {
      continue;
    }

    const deploymentNames = collectDeploymentNames(engineResults, summaryMetrics);
    for (const deploymentName of deploymentNames) {
      deployments.push(createDeploymentSummary(deploymentName, engine, engineResults, store, runId));
    }
  }

  return {
    ts: Date.now(),
    runId,
    sessionId,
    deployments,
  };
}

function mergeAnomaliesIntoSummary(
  summary: HeadMonitoringSummaryRecord,
  events: Array<AnomalyEvent & { eventId: string }>,
): HeadMonitoringSummaryRecord {
  for (const event of events) {
    let deploymentSummary = summary.deployments.find(
      (deployment) => deployment.deploymentName === event.deploymentName,
    );

    if (!deploymentSummary) {
      deploymentSummary = {
        deploymentName: event.deploymentName,
        engine: 'unknown',
        metricTable: [],
        anomalyTable: [],
      };
      summary.deployments.push(deploymentSummary);
    }

    const anomalyRow: HeadMonitoringAnomalyRow = {
      anomalyIdOrName: event.eventId,
      metric: event.metricName,
      severity: event.severity,
      observation: event.reasoning?.trim() || `${event.type} detected`,
    };

    const existingIndex = deploymentSummary.anomalyTable.findIndex(
      (row) => row.anomalyIdOrName === anomalyRow.anomalyIdOrName,
    );
    if (existingIndex >= 0) {
      deploymentSummary.anomalyTable[existingIndex] = anomalyRow;
    } else {
      deploymentSummary.anomalyTable.push(anomalyRow);
    }
  }

  return summary;
}

function getPluginConfig(ctx?: OpenClawPluginServiceContext): Record<string, unknown> {
  const serviceConfig = ctx?.config && typeof ctx.config === 'object'
    ? ctx.config as Record<string, unknown>
    : {};
  return {
    ...pluginConfig,
    ...serviceConfig,
  };
}

/**
 * Extract all top-level JSON object strings from text using brace-depth tracking.
 * Handles the case where an LLM returns multiple {...} blocks separated by prose.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

interface PlannerSubmission {
  taskId: string;
  taskType: string;
  config: Record<string, unknown>;
  reasoning: string;
  perfEvidence?: string;
  simulationResults?: string;
}

function extractExpectedTaskId(taskInstruction: string): string | undefined {
  try {
    const bare = taskInstruction.match(/"taskId"\s*:\s*"([^"]+)"/);
    return bare?.[1];
  } catch {
    return undefined;
  }
}

async function applyPlannerSubmission(submission: PlannerSubmission): Promise<{ success: true; taskId: string; message: string } | { error: string }> {
  pluginLogger?.debug(`[PlanTask] applyPlannerSubmission called`, { taskId: submission.taskId, taskType: submission.taskType });

  if (!taskRecorder) {
    pluginLogger?.debug(`[PlanTask] service not running, rejecting submission`);
    return { error: 'PimClaw service not running' };
  }

  const task = taskRecorder.getTask(submission.taskId);
  if (!task) {
    pluginLogger?.debug(`[PlanTask] task not found`, { taskId: submission.taskId });
    return { error: `Task ${submission.taskId} not found` };
  }

  if (task.status !== 'planning') {
    pluginLogger?.debug(`[PlanTask] invalid task status`, { taskId: submission.taskId, currentStatus: task.status });
    return { error: `Task ${submission.taskId} is in '${task.status}' state, expected 'planning'` };
  }

  pluginLogger?.debug(`[PlanTask] taskType decided by planner`, {
    taskId: submission.taskId,
    taskType: submission.taskType,
    source: 'planner-agent',
    hasPerfEvidence: !!submission.perfEvidence,
    hasSimulationResults: !!submission.simulationResults,
    reasoningSnippet: submission.reasoning,
  });
  task.taskType = submission.taskType;
  task.config = submission.config;
  task.reasoning = submission.reasoning;
  task.perfEvidence = submission.perfEvidence;
  task.simulationResults = submission.simulationResults;

  clearPlanningFallback(submission.taskId);
  pluginLogger?.debug(`[PlanTask] fallback timer cleared`, { taskId: submission.taskId });
  await taskRecorder.updateTaskStatus(submission.taskId, 'ready');

  pluginLogger?.debug(`[PlanTask] task transitioned planning → ready`, { taskId: submission.taskId });
  return {
    success: true,
    taskId: submission.taskId,
    message: `Task ${submission.taskId} planned and ready for scheduling`,
  };
}

function createCliPlannerAgentApi(ctx: OpenClawPluginServiceContext): OpenClawAgentApi {
  return {
    async triggerAgent(agentId, options) {
      const expectedTaskId = extractExpectedTaskId(options.task);
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
          // The CLI shim has to force per-run isolation itself because it is
          // emulating the one-shot planner semantics the injected API provides.
          '--session-id', uuidv4(),
          '--message', plannerInstruction,
          '--timeout', String(options.runTimeoutSeconds),
          '--json',
        ],
        {
          cwd: options.workspaceDir ?? ctx.workspaceDir,
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

      if (expectedTaskId) {
        const taskStatus = taskRecorder?.getTask(expectedTaskId)?.status;
        if (taskStatus && taskStatus !== 'planning') {
          pluginLogger?.debug(`[PlanTask] planner CLI run already applied via tool`, {
            taskId: expectedTaskId,
            currentStatus: taskStatus,
          });
          return;
        }
      }

      const plannerText = parsed?.result?.payloads?.map((payload: any) => payload?.text ?? '').join('\n').trim();
      if (!plannerText) {
        throw new Error('planner CLI returned no text payload');
      }

      let submission: PlannerSubmission;
      try {
        submission = JSON.parse(plannerText);
      } catch {
        // LLM may have added preamble prose, markdown fences, or returned multiple
        // JSON objects (one per anomaly). Use a brace-depth extractor to find all
        // top-level {...} blocks, then pick the one whose taskId matches.
        const candidates = extractJsonObjects(plannerText);
        if (candidates.length === 0) {
          throw new Error(
            `planner CLI returned no JSON object | raw: ${plannerText.slice(0, 300)}`,
          );
        }
        let matched: PlannerSubmission | undefined;
        const parseErrors: string[] = [];
        for (const candidate of candidates) {
          try {
            const parsed = JSON.parse(candidate) as PlannerSubmission;
            if (!matched) matched = parsed; // first valid candidate as fallback
            if (expectedTaskId && parsed.taskId === expectedTaskId) {
              matched = parsed;
              break;
            }
          } catch (e) {
            parseErrors.push(e instanceof Error ? e.message : String(e));
          }
        }
        if (!matched) {
          throw new Error(
            `planner CLI did not return valid JSON (tried ${candidates.length} candidates): ${parseErrors.join('; ')} | raw: ${plannerText.slice(0, 300)}`,
          );
        }
        pluginLogger?.debug(`[PlanTask] extracted JSON from multi-object response`, {
          candidateCount: candidates.length,
          expectedTaskId,
          matchedTaskId: matched.taskId,
        });
        submission = matched;
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

  pluginLogger?.debug(`[PlanTask] taskType decided by fallback`, {
    taskId,
    taskType: plannerFallbackTaskType,
    source: 'fallback',
    reason,
    fallbackConfig: plannerFallbackConfig,
  });
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

      // File-based rotating logger (wraps ctx.logger so lines go to both)
      const logDir = path.join(ctx.stateDir, 'logs');
      fileLogger = new FileLogger({ logDir, maxFiles: 10, maxFileSizeBytes: 5 * 1024 * 1024 }, ctx.logger);
      await fileLogger.initialize();
      pluginLogger = fileLogger;

      const config = getPluginConfig(ctx);

      // 1. Shared infrastructure
      registry = new ComponentRegistry();
      taskRecorder = new TaskStatusRecorder(
        `${ctx.stateDir}/pimclaw-tasks`,
        registry,
        fileLogger,
      );
      await taskRecorder.initialize();

      const agentWorkspaceRoot = path.join(ctx.workspaceDir, '.pimclaw-agents');
      const headWorkspaceDir = path.join(agentWorkspaceRoot, 'head');
      const plannerConfig = (config as any)?.planner ?? {};
      const plannerWorkspaceDir = plannerConfig.workspaceDir ?? path.join(agentWorkspaceRoot, 'planner');

      await fs.mkdir(headWorkspaceDir, { recursive: true });
      await fs.mkdir(plannerWorkspaceDir, { recursive: true });

      // 2. PlannerTrigger — spawns Planner agent via OpenClaw API
      plannerFallbackTaskType = plannerConfig.fallbackTaskType ?? 'scale-up';
      plannerFallbackConfig = plannerConfig.fallbackConfig ?? { replicaDelta: 1 };
      const plannerAgentApi = selectPlannerAgentApi(
        (ctx as any).openclawApi,
        () => createCliPlannerAgentApi(ctx),
      );
      if (plannerAgentApi.mode === 'cli-fallback') {
        ctx.logger.info('[PimClaw] Using CLI-based planner trigger fallback');
      } else {
        ctx.logger.info('[PimClaw] Using injected OpenClaw agent API for planner trigger');
      }
      const plannerTrigger = new PlannerTrigger(plannerAgentApi.api, taskRecorder, {
        agentId: plannerConfig.agentId ?? 'pimclaw-planner',
        timeoutSeconds: plannerConfig.timeoutSeconds ?? 600,
        workspaceDir: plannerWorkspaceDir,
      }, registry, fileLogger);

      ctx.logger.info(
        `[PimClaw] Dedicated agent workspaces ready: head=${headWorkspaceDir}, planner=${plannerWorkspaceDir}`,
      );

      // 3. AnomalyReceiver — validates events from LLM Head, triggers Planner
      const receiverConfig = (config as any)?.anomalyReceiver ?? {};
      planningTimeoutMs = receiverConfig.planningTimeoutMs ?? 600_000;
      anomalyReceiver = new AnomalyReceiver(
        taskRecorder,
        plannerTrigger,
        receiverConfig,
        {
          onPlanningTaskCreated: async (taskId) => {
            schedulePlanningFallback(taskId);
          },
          onPlannerTriggerFailed: async (taskId, _events, error) => {
            const message = error instanceof Error ? error.message : String(error);
            await applyFallbackPlan(taskId, `planner trigger failed: ${message}`);
          },
        },
        registry,
        fileLogger,
      );

      // 4. Scheduler — polls for ready tasks, spawns Workers
      scheduler = new SchedulerAgent(registry, taskRecorder, undefined, taskExecutor ?? undefined, fileLogger);
      await scheduler.initialize();
      scheduler.run().catch((err) =>
        ctx.logger.error(`[PimClaw] Scheduler error: ${err}`),
      );

      // 5. PrometheusClient — for pimclaw_query_metrics tool
      const promCfg = (config as any)?.prometheus;
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
        activeEngines = parseEngineConfig(promCfg.engine);
        ctx.logger.info(`[PimClaw] Prometheus client configured → ${promCfg.baseUrl} (engines: ${activeEngines.join(', ')})`);
      } else {
        ctx.logger.warn('[PimClaw] No prometheus.baseUrl configured — pimclaw_query_metrics will be unavailable');
      }

      // 5b. MetricsStore — ring-buffer for metrics history (max 1000 records, ~185 KB)
      metricsStore = new MetricsStore(`${ctx.stateDir}`, 1000);
      await metricsStore.load();
      ctx.logger.info(`[PimClaw] MetricsStore loaded (${metricsStore.size} existing records)`);

      headSummaryStore = new HeadSummaryStore(headWorkspaceDir, 10);
      await headSummaryStore.load();
      ctx.logger.info(`[PimClaw] HeadSummaryStore loaded (${headSummaryStore.size} existing records)`);

      // 6. EngineMcpClient + TaskExecutor — for Worker execution via qianjin-xuntui MCP
      const engineCfg = (config as any)?.engineMcp;
      if (engineCfg?.sseUrl && engineCfg?.username && engineCfg?.password) {
        try {
          engineMcpClient = new EngineMcpClient({
            sseUrl: engineCfg.sseUrl,
            username: engineCfg.username,
            password: engineCfg.password,
            tenantId: engineCfg.tenantId,
            tokenRefreshMarginMs: engineCfg.tokenRefreshMarginMs,
          });
          await engineMcpClient.connect();
          taskExecutor = new TaskExecutor(engineMcpClient);
          // Hot-wire the executor into the already-created scheduler
          if (scheduler) {
            (scheduler as any).taskExecutor = taskExecutor;
          }
          ctx.logger.info(`[PimClaw] Engine MCP connected → ${engineCfg.sseUrl}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`[PimClaw] Engine MCP connection failed: ${msg}`);
          engineMcpClient = null;
          taskExecutor = null;
        }
      } else {
        ctx.logger.warn('[PimClaw] No engineMcp config — Worker task execution will be unavailable');
      }

      // 7. PerfMcpClient — for Planner historical performance queries
      const perfCfg = (config as any)?.perfMcp;
      if (perfCfg?.serverScriptPath) {
        try {
          perfMcpClient = new PerfMcpClient({
            pythonPath: perfCfg.pythonPath,
            serverScriptPath: perfCfg.serverScriptPath,
            env: perfCfg.env,
          });
          await perfMcpClient.connect();
          ctx.logger.info(`[PimClaw] Perf MCP connected → ${perfCfg.serverScriptPath}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`[PimClaw] Perf MCP connection failed: ${msg}`);
          perfMcpClient = null;
        }
      } else {
        ctx.logger.warn('[PimClaw] No perfMcp.serverScriptPath configured — pimclaw_query_perfllm will be unavailable');
      }

      // 8. SimMcpClient — for Planner simulation-based config validation
      const simCfg = (config as any)?.simMcp;
      if (simCfg?.sseUrl) {
        try {
          simMcpClient = new SimMcpClient({
            sseUrl: simCfg.sseUrl,
          });
          await simMcpClient.connect();
          ctx.logger.info(`[PimClaw] Sim MCP connected → ${simCfg.sseUrl}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`[PimClaw] Sim MCP connection failed: ${msg}`);
          simMcpClient = null;
        }
      } else {
        ctx.logger.warn('[PimClaw] No simMcp.sseUrl configured — pimclaw_sim_* tools will be unavailable');
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
      if (engineMcpClient) {
        await engineMcpClient.disconnect();
        engineMcpClient = null;
      }
      if (perfMcpClient) {
        await perfMcpClient.disconnect();
        perfMcpClient = null;
      }
      if (simMcpClient) {
        await simMcpClient.disconnect();
        simMcpClient = null;
      }
      taskExecutor = null;
      registry = null;
      if (metricsStore) {
        await metricsStore.flush();
        metricsStore = null;
      }
      if (headSummaryStore) {
        await headSummaryStore.flush();
        headSummaryStore = null;
      }
      currentHeadRunIds.clear();
      prometheusClient = null;
      prometheusQueryOverrides = {};
      prometheusDefaultLabels = {};
      activeEngines = [...ALL_ENGINES];
      pluginConfig = {};
      pluginRuntime = null;
      if (fileLogger) {
        await fileLogger.close();
        fileLogger = null;
      }
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
      'Query Prometheus for inference metrics (TTFT, TPOT, QPS, throughput, GPU utilization, error rate) across all configured inference engines (vllm, sglang). Results are grouped by engine. Use rangeMinutes to get time-series data as [timestamp, value] pairs for trend analysis. Called by the Head Agent every 5 minutes.',
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
          description: 'model_name label to filter by',
        },
        engine: {
          oneOf: [
            { type: 'string', enum: ['vllm', 'sglang'] },
            { type: 'array', items: { type: 'string', enum: ['vllm', 'sglang'] } },
          ],
          description:
            'Filter to specific engine(s). Accepts a single engine name or an array. Default: all configured engines.',
        },
        rangeMinutes: {
          type: 'number',
          description: 'Return time-series [timestamp, value] pairs over this many minutes (step ~15s). Use 5 to match the Head Agent cron interval.',
        },
      },
    },
    async execute(sessionId: string, params: Record<string, unknown>) {
      if (!prometheusClient) {
        return {
          output: JSON.stringify({
            error: 'Prometheus not configured. Set prometheus.baseUrl in plugin config.',
          }),
        };
      }

      // Determine which engines to query: per-call param > config-level activeEngines
      const engines: InferenceEngine[] = params.engine
        ? parseEngineConfig(params.engine)
        : activeEngines;

      const requestedMetrics = (params.metrics as string[] | undefined) ?? allMetricNames();
      const deploymentName = params.deploymentName as string | undefined;
      const rangeMinutes = params.rangeMinutes as number | undefined;
      const nowSec = Math.floor(Date.now() / 1000);

      const grouped: Record<string, Record<string, unknown>> = {};

      for (const engine of engines) {
        const promqlMap = getPromQLMap(engine);
        const engineResults: Record<string, unknown> = {};

        for (const metric of requestedMetrics) {
          // Resolve PromQL: config override > engine-specific map
          let promql = prometheusQueryOverrides[metric] ?? promqlMap[metric];
          if (!promql) {
            // This metric may not exist for this engine — skip silently
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
              engineResults[metric] = await prometheusClient!.queryRange(promql, start, nowSec, step);
            } else {
              engineResults[metric] = await prometheusClient!.query(promql);
            }
          } catch (err) {
            engineResults[metric] = { error: err instanceof Error ? err.message : String(err) };
          }
        }

        grouped[engine] = engineResults;
      }

      // Persist a single record with per-deployment flat metrics
      if (metricsStore) {
        const allDeploymentMetrics: DeploymentMetrics[] = [];

        for (const engine of engines) {
          const engineResults = grouped[engine];
          if (!engineResults) continue;

          // Collect unique deployment names across all metrics for this engine
          const deploymentNames = collectDeploymentNames(engineResults, requestedMetrics);

          // Build a flat entry per deployment
          for (const depName of deploymentNames) {
            const entry: DeploymentMetrics = {
              deployments: depName,
              engine,
              ttft: 0, tpot: 0, qps: 0,
              throughput: 0, gpu_utilization: 0, error_rate: 0,
            };
            for (const metric of summaryMetrics) {
              const results = engineResults[metric] as any[];
              if (Array.isArray(results)) {
                const match = results.find((r: any) => r?.metric?.model_name === depName);
                if (match) {
                  const val = extractMetricValue([match]);
                  entry[metric] = val != null && !Number.isNaN(val) ? val : 0;
                }
              }
            }
            allDeploymentMetrics.push(entry);
          }
        }

        metricsStore.add({ ts: Date.now(), metrics: allDeploymentMetrics });
        metricsStore.flush().catch(() => {});
      }

      if (headSummaryStore && typeof rangeMinutes === 'number' && rangeMinutes > 0) {
        const runId = uuidv4();
        const summaryRecord = buildHeadSummaryRecord(
          sessionId,
          grouped,
          engines,
          runId,
          headSummaryStore,
        );
        headSummaryStore.upsert(summaryRecord);
        currentHeadRunIds.set(sessionId, runId);
        headSummaryStore.flush().catch(() => {});
      }

      return { output: JSON.stringify(grouped) };
    },
  });

  // ── Gate 1: LLM Head Agent → Plugin ──────────────────────────────────────

  const submitAnomaliesTool = () => ({
    name: 'pimclaw_submit_anomalies',
    description:
      'Submit detected anomaly events for task planning. Called by the PimClaw Head Agent after analyzing Prometheus metrics.',
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
    async execute(sessionId: string, params: Record<string, unknown>) {
      if (!anomalyReceiver) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      try {
        const events = params.events as AnomalyEvent[];
        const validated = await anomalyReceiver.receive(events);

        if (headSummaryStore) {
          const runId = currentHeadRunIds.get(sessionId);
          if (runId) {
            const summary = headSummaryStore.getByRunId(runId);
            if (summary) {
              mergeAnomaliesIntoSummary(summary, validated);
              headSummaryStore.upsert(summary);
              headSummaryStore.flush().catch(() => {});
            }
          }
        }

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
      pluginLogger?.debug(`[PlanTask] tool invoked`, { taskId: params.taskId, taskType: params.taskType });
      try {
        const result = await applyPlannerSubmission({
          taskId: params.taskId as string,
          taskType: params.taskType as string,
          config: params.config as Record<string, unknown>,
          reasoning: params.reasoning as string,
          perfEvidence: params.perfEvidence as string | undefined,
          simulationResults: params.simulationResults as string | undefined,
        });

        pluginLogger?.debug(`[PlanTask] tool result`, { taskId: params.taskId, success: !('error' in result) });
        return { output: JSON.stringify(result) };
      } catch (err) {
        pluginLogger?.debug(`[PlanTask] tool error`, { taskId: params.taskId, error: err instanceof Error ? err.message : String(err) });
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
      pluginLogger?.debug(`[RouteTask] taskType decided by caller`, {
        taskType: params.taskType,
        source: 'pimclaw_route_task',
        deploymentName: params.llmDeploymentName,
        priority: params.priority ?? 'medium',
      });
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

  // ── Perf MCP Tools (perfllm historical data) ────────────────────────────

  const queryPerfllmTool = () => ({
    name: 'pimclaw_query_perfllm',
    description:
      'Query the perfllm database for historical LLM performance benchmark data. ' +
      'Returns deployment configs and their measured TTFT, TPOT, QPS, throughput. ' +
      'Called by the Planner Agent to find candidate configurations.',
    parameters: {
      type: 'object' as const,
      properties: {
        model_name: { type: 'string', description: 'Filter by model name (e.g. Qwen/Qwen3-235B-A22B)' },
        scenario: { type: 'string', description: 'Filter by test scenario (e.g. vibe-coding)' },
        engine_name: { type: 'string', description: 'Filter by inference engine (e.g. vllm, sglang)' },
        device_type: { type: 'string', description: 'Filter by hardware type (e.g. nvidia/h800)' },
        node_num: { type: 'number', description: 'Filter by number of nodes' },
        device_per_node: { type: 'number', description: 'Filter by devices per node' },
        limit: { type: 'number', description: 'Max rows to return (default 10, max 100)' },
      },
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      pluginLogger?.debug(`[Planner:PerfQuery] historical perf query started`, {
        model_name: params.model_name,
        engine_name: params.engine_name,
        device_type: params.device_type,
        scenario: params.scenario,
        node_num: params.node_num,
        device_per_node: params.device_per_node,
        limit: params.limit,
      });
      if (!perfMcpClient) {
        pluginLogger?.debug(`[Planner:PerfQuery] perf MCP not configured, returning error`);
        return {
          output: JSON.stringify({
            error: 'Perf MCP not configured. Set perfMcp.serverScriptPath in plugin config.',
          }),
        };
      }
      try {
        const result = await perfMcpClient.queryPerfllm(params);
        const rowCount = Array.isArray(result) ? result.length : (result as any)?.rows?.length ?? '?';
        pluginLogger?.debug(`[Planner:PerfQuery] historical perf query returned`, { rowCount });
        return { output: JSON.stringify(result) };
      } catch (err) {
        pluginLogger?.debug(`[Planner:PerfQuery] historical perf query failed`, { error: err instanceof Error ? err.message : String(err) });
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  const getPerfllmSchemaTool = () => ({
    name: 'pimclaw_get_perfllm_schema',
    description:
      'Get the schema of the perfllm database table. Shows all available columns, ' +
      'types, and nullability. Use this to understand what data is available before querying.',
    parameters: { type: 'object' as const, properties: {} },
    async execute() {
      pluginLogger?.debug(`[Planner:PerfQuery] fetching perfllm schema`);
      if (!perfMcpClient) {
        pluginLogger?.debug(`[Planner:PerfQuery] perf MCP not configured, returning error`);
        return {
          output: JSON.stringify({
            error: 'Perf MCP not configured. Set perfMcp.serverScriptPath in plugin config.',
          }),
        };
      }
      try {
        const result = await perfMcpClient.getSchema();
        pluginLogger?.debug(`[Planner:PerfQuery] perfllm schema fetched`);
        return { output: JSON.stringify(result) };
      } catch (err) {
        pluginLogger?.debug(`[Planner:PerfQuery] perfllm schema fetch failed`, { error: err instanceof Error ? err.message : String(err) });
        return {
          output: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    },
  });

  // ── Simulator MCP Tools (Hisim hardware-aware simulation) ────────────────

  /** Helper: create a sim tool that proxies to SimMcpClient.callTool() */
  function simTool(
    name: string,
    hisimToolName: string,
    description: string,
    parameters: Record<string, unknown>,
  ) {
    return () => ({
      name,
      description,
      parameters,
      async execute(_sessionId: string, params: Record<string, unknown>) {
        pluginLogger?.debug(`[Planner:Sim] ${name} called`, {
          hisimTool: hisimToolName,
          model: (params.model_path ?? params.model) as string | undefined,
          hardware: params.hardware_name as string | undefined,
          tpSize: params.tp_size,
          dataType: params.data_type,
          datasetName: params.dataset_name,
          requestRate: params.request_rate,
        });
        if (!simMcpClient) {
          pluginLogger?.debug(`[Planner:Sim] sim MCP not configured, returning error`, { hisimTool: hisimToolName });
          return {
            output: JSON.stringify({
              error: 'Sim MCP not configured. Set simMcp.sseUrl in plugin config.',
            }),
          };
        }
        try {
          const result = await simMcpClient.callTool(hisimToolName, params);
          pluginLogger?.debug(`[Planner:Sim] ${name} returned`, { hisimTool: hisimToolName });
          return { output: JSON.stringify(result) };
        } catch (err) {
          pluginLogger?.debug(`[Planner:Sim] ${name} failed`, { hisimTool: hisimToolName, error: err instanceof Error ? err.message : String(err) });
          return {
            output: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          };
        }
      },
    });
  }

  const simRegisterHardwareTool = simTool(
    'pimclaw_sim_register_hardware',
    'register_hardware',
    'Register a hardware accelerator with performance specs for simulation.',
    {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Hardware name (e.g. "NVIDIA H800")' },
        vendor: { type: 'string', description: 'Hardware vendor (e.g. "NVIDIA")' },
        hbm_capacity_gb: { type: 'number', description: 'HBM capacity in GB' },
        hbm_bandwidth_gb: { type: 'number', description: 'HBM bandwidth in GB/s' },
        fp16_tflops: { type: 'number', description: 'FP16 TFLOPS' },
        fp32_tflops: { type: 'number', description: 'FP32 TFLOPS' },
        fp64_tflops: { type: 'number', description: 'FP64 TFLOPS' },
        int8_tflops: { type: 'number', description: 'INT8 TFLOPS' },
        fp8_tflops: { type: 'number', description: 'FP8 TFLOPS' },
        bf16_tflops: { type: 'number', description: 'BF16 TFLOPS' },
        num_devices: { type: 'number', description: 'Number of devices' },
        device_alias: { type: 'array', items: { type: 'string' }, description: 'Device aliases' },
        inter_node_bandwidth_gb: { type: 'number', description: 'Inter-node bandwidth in GB/s' },
        intra_node_bandwidth_gb: { type: 'number', description: 'Intra-node bandwidth in GB/s' },
      },
      required: ['name', 'vendor', 'hbm_capacity_gb', 'hbm_bandwidth_gb'],
    },
  );

  const simListHardwareTool = simTool(
    'pimclaw_sim_list_hardware',
    'list_all_hardware',
    'List all registered hardware accelerators available for simulation.',
    { type: 'object' as const, properties: {} },
  );

  const simStartTool = simTool(
    'pimclaw_sim_start',
    'start_simulation_server',
    'Start SGLang simulation server with hardware-aware configuration. Must register hardware first.',
    {
      type: 'object' as const,
      properties: {
        model_path: { type: 'string', description: 'Model path (e.g. "Qwen/Qwen2.5-7B-Instruct")' },
        hardware_name: { type: 'string', description: 'Registered hardware name (e.g. "NVIDIA H800")' },
        database_path: { type: 'string', description: 'Hardware performance database path' },
        port: { type: 'number', description: 'Service port (default: 8001)' },
        tp_size: { type: 'number', description: 'Tensor parallelism size' },
        ep_size: { type: 'number', description: 'Expert parallelism size' },
        dp_size: { type: 'number', description: 'Data parallelism size' },
        data_type: { type: 'string', description: 'Data type: FP16, FP32, BF16, FP8, INT8' },
        prefill_scale_factor: { type: 'number', description: 'Prefill latency scale factor' },
        decode_scale_factor: { type: 'number', description: 'Decode latency scale factor' },
        database_mode: { type: 'string', description: 'SILICON or SIMULATION' },
        xgb_model_path: { type: 'string', description: 'XGBoost model path for prediction' },
        skip_warmup: { type: 'boolean', description: 'Skip server warmup (default: true)' },
      },
      required: ['model_path', 'hardware_name', 'database_path'],
    },
  );

  const simStopTool = simTool(
    'pimclaw_sim_stop',
    'stop_simulation_server',
    'Stop the running simulation server.',
    { type: 'object' as const, properties: {} },
  );

  const simStatusTool = simTool(
    'pimclaw_sim_status',
    'get_simulation_server_status',
    'Get the current simulation server status (running, PID, port, model).',
    { type: 'object' as const, properties: {} },
  );

  const simBenchmarkTool = simTool(
    'pimclaw_sim_benchmark',
    'run_bench_serving',
    'Run benchmark serving against the simulation server. Returns TTFT, TPOT, throughput, and other performance metrics. Simulation server must be running first.',
    {
      type: 'object' as const,
      properties: {
        model: { type: 'string', description: 'Model name (should match simulation server model)' },
        backend: { type: 'string', description: 'Backend type (default: "sglang")' },
        dataset_name: { type: 'string', description: 'Dataset type: random, sharegpt, hisim-collection' },
        dataset_path: { type: 'string', description: 'Path to dataset file (for sharegpt/hisim-collection)' },
        num_prompts: { type: 'number', description: 'Number of prompts (for random dataset)' },
        random_input_len: { type: 'number', description: 'Input token length (for random dataset)' },
        random_output_len: { type: 'number', description: 'Output token length (for random dataset)' },
        request_rate: { type: 'number', description: 'Requests per second (inf = all at once)' },
        max_concurrency: { type: 'number', description: 'Maximum concurrent requests' },
        base_url: { type: 'string', description: 'Simulation server base URL (default: "http://127.0.0.1:8001")' },
      },
      required: ['model'],
    },
  );

  const simDatasetInfoTool = simTool(
    'pimclaw_sim_dataset_info',
    'get_bench_serving_dataset_info',
    'Preview dataset information (token counts, prompt lengths) without running a benchmark.',
    {
      type: 'object' as const,
      properties: {
        dataset_name: { type: 'string', description: 'Dataset type: random, sharegpt, hisim-collection' },
        dataset_path: { type: 'string', description: 'Path to dataset file' },
        model: { type: 'string', description: 'Model name for tokenization' },
        num_prompts: { type: 'number', description: 'Number of prompts to preview' },
      },
      required: ['dataset_name', 'model'],
    },
  );

  return [
    submitAnomaliesTool,
    planTaskTool,
    routeTaskTool,
    queryMetricsTool,
    queryPerfllmTool,
    getPerfllmSchemaTool,
    simRegisterHardwareTool,
    simListHardwareTool,
    simStartTool,
    simStopTool,
    simStatusTool,
    simBenchmarkTool,
    simDatasetInfoTool,
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
    pluginConfig = (api.pluginConfig as Record<string, unknown> | undefined) ?? {};
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
