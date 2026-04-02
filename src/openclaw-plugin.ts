/**
 * PimClaw OpenClaw Plugin
 *
 * Integrates with OpenClaw via:
 *   - definePluginEntry()   — plugin registration
 *   - api.registerService() — lifecycle-managed background service that
 *     boots the Head Agent, TaskStatusRecorder, and Scheduler Agent
 *   - api.registerTool()    — exposes PimClaw tools to OpenClaw agents
 *
 * Install the plugin, and the three core agents start automatically
 * inside the OpenClaw process.
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import { AgentRegistry } from './master/agent-registry.js';
import { TaskStatusRecorder } from './master/task-status-recorder.js';
import { SchedulerAgent } from './master/scheduler-agent.js';
import { HeadAgent } from './master/head-agent.js';
import type { Task } from './types/index.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Shared state across the plugin (lives for the OpenClaw process) ───────

let registry: AgentRegistry | null = null;
let taskRecorder: TaskStatusRecorder | null = null;
let scheduler: SchedulerAgent | null = null;
let head: HeadAgent | null = null;

// ─── Service: lifecycle-managed background agents ──────────────────────────

function createPimClawService(): OpenClawPluginService {
  return {
    id: 'pimclaw-agents',

    async start(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info('[PimClaw] Starting agents…');

      // 1. Shared infrastructure
      registry = new AgentRegistry();
      taskRecorder = new TaskStatusRecorder(
        // Use OpenClaw's stateDir for persistence so data survives restarts
        `${ctx.stateDir}/pimclaw-tasks`,
      );
      await taskRecorder.initialize();

      // 2. Scheduler Agent
      scheduler = new SchedulerAgent(registry, taskRecorder);
      await scheduler.initialize();
      scheduler.run().catch((err) =>
        ctx.logger.error(`[PimClaw] Scheduler error: ${err}`),
      );

      // 3. Head Agent (Observe-Think-Decide)
      head = new HeadAgent(registry, taskRecorder);
      // Override Head's snapshot storage to OpenClaw's stateDir
      (head as any).storagePath = `${ctx.stateDir}/pimclaw-head-data`;
      await head.initialize();
      head.run().catch((err) =>
        ctx.logger.error(`[PimClaw] Head error: ${err}`),
      );

      ctx.logger.info(
        '[PimClaw] All agents started (TaskRecorder → Scheduler → Head)',
      );
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info('[PimClaw] Stopping agents…');

      // Reverse startup order
      if (head) {
        await head.shutdown();
        head = null;
      }
      if (scheduler) {
        await scheduler.shutdown();
        scheduler = null;
      }
      if (taskRecorder) {
        await taskRecorder.persist();
        taskRecorder = null;
      }
      registry = null;

      ctx.logger.info('[PimClaw] All agents stopped');
    },
  };
}

// ─── Tool builders ─────────────────────────────────────────────────────────

function buildPimClawTools() {
  // Each builder returns an AnyAgentTool-compatible object.
  // They close over the module-level registry / taskRecorder so they always
  // refer to the current running instance (set by the service start hook).

  const routeTaskTool = () => ({
    name: 'pimclaw_route_task',
    description:
      'Submit a task to PimClaw. The Scheduler Agent picks it up and creates a Worker.',
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

  const listAgentsTool = () => ({
    name: 'pimclaw_list_agents',
    description: 'List all active PimClaw agents and their runtime status.',
    parameters: {
      type: 'object' as const,
      properties: {
        agentType: {
          type: 'string',
          description: 'Filter by type (head, scheduler, recorder, worker)',
        },
      },
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const agents = registry.getAllAgentsStatus();
      const filtered = params.agentType
        ? agents.filter((a) => a.agentType === params.agentType)
        : agents;
      return { output: JSON.stringify(filtered) };
    },
  });

  const agentStatusTool = () => ({
    name: 'pimclaw_agent_status',
    description: 'Get detailed runtime status of a specific PimClaw agent.',
    parameters: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'Agent ID' },
      },
      required: ['agentId'],
    },
    async execute(_sessionId: string, params: Record<string, unknown>) {
      if (!registry) {
        return { output: JSON.stringify({ error: 'PimClaw service not running' }) };
      }
      const status = registry.getAgentStatus(params.agentId as string);
      return { output: JSON.stringify(status ?? { error: 'Agent not found' }) };
    },
  });

  const healthTool = () => ({
    name: 'pimclaw_health',
    description:
      'Get the overall PimClaw health report including agent status and detected issues.',
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
            'Filter by status (ready, scheduling, scheduled, running, done, failed, expired)',
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
    routeTaskTool,
    listAgentsTool,
    agentStatusTool,
    healthTool,
    taskCountsTool,
    listTasksTool,
    retryTaskTool,
    revokeTaskTool,
  ];
}

// ─── Plugin entry point ────────────────────────────────────────────────────

export default definePluginEntry({
  id: 'pimclaw',
  name: 'PimClaw',
  description:
    'LLM deployment orchestration — automatically monitors metrics, detects anomalies, and schedules corrective tasks.',

  register(api: OpenClawPluginApi) {
    // 1. Register the background service that boots all agents
    api.registerService(createPimClawService());

    // 2. Register each tool so OpenClaw agents can call them
    for (const toolFactory of buildPimClawTools()) {
      api.registerTool(toolFactory);
    }

    api.logger.info('[PimClaw] Plugin registered');
  },
});
