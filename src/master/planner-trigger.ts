/**
 * PlannerTrigger — spawns a Planner agent via OpenClaw API
 * for each validated anomaly event.
 */

import type { ValidatedEvent } from './anomaly-receiver.js';
import type { ComponentRegistry } from './component-registry.js';
import type { PlannerMemoryEpisode, PlannerMemoryLesson } from '../types/index.js';
import { PlannerMemoryStore } from './planner-memory-store.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import type { AgentCounters, TaskStatus } from '../types/index.js';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

export interface OpenClawAgentApi {
  /**
   * Launch a single planner run with isolated execution semantics.
   * Concurrent calls must not share planner conversation state.
   * `mode: 'run'` requests one-shot execution, and `cleanup: 'delete'`
   * means the planner session should not be retained after completion.
   */
  triggerAgent(agentId: string, options: {
    task: string;
    mode: string;
    cleanup: string;
    runTimeoutSeconds: number;
    workspaceDir?: string;
    attachments?: Array<{ type: string; content: string }>;
  }): Promise<void>;
}

export interface PlannerTriggerConfig {
  agentId: string;
  timeoutSeconds: number;
  workspaceDir?: string;
}

export interface PlannerTriggerPayload {
  events: ValidatedEvent[];
  deploymentName: string;
  taskId: string;
}

export interface PlannerMemoryContextPayload {
  deploymentName: string;
  recentEpisodes: PlannerMemoryEpisode[];
  activeLessons: PlannerMemoryLesson[];
}

interface PlannerOutputFormatExample {
  taskId: string;
  taskType: 'scale-up' | 'scale-down' | 'restart' | 'reconfigure';
  config: {
    replicas: number;
    dtype: 'fp16' | 'bf16' | 'fp8' | 'int8' | 'int4';
    quantization: string | null;
    maxBatchSize: number;
    tensorParallelism: number;
  };
  reasoning: string;
  perfEvidence: string;
  simulationResults: string;
  webReferences: string[];
}

const DEFAULT_CONFIG: PlannerTriggerConfig = {
  agentId: 'pimclaw-planner',
  timeoutSeconds: 600,
};

export class PlannerTrigger {
  private readonly taskRecorder: TaskStatusRecorder;
  private openclawApi: OpenClawAgentApi;
  private config: PlannerTriggerConfig;
  private readonly registry: ComponentRegistry | null;
  private readonly plannerMemoryStore: PlannerMemoryStore | null;
  private readonly logger: PluginLogger | null;
  private readonly agentId = 'planner-trigger';

  constructor(openclawApi: OpenClawAgentApi, taskRecorder: TaskStatusRecorder, config?: Partial<PlannerTriggerConfig>, registry?: ComponentRegistry, plannerMemoryStore?: PlannerMemoryStore, logger?: PluginLogger) {
    this.openclawApi = openclawApi;
    this.taskRecorder = taskRecorder;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = registry ?? null;
    this.plannerMemoryStore = plannerMemoryStore ?? null;
    this.logger = logger ?? null;

    if (this.registry) {
      this.registry.registerAgent({
        agentId: this.agentId,
        agentType: 'trigger',
        status: 'Listening',
        startedAt: new Date(),
        lastActivityAt: new Date(),
        mcpConnections: {},
        counters: { triggersAttempted: 0, triggersSucceeded: 0, triggersFailed: 0 },
        errors: { errorCount: 0, lastError: undefined, lastErrorAt: undefined },
      });
    }
  }

  private debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger?.debug(`[PlannerTrigger] ${message}`, context);
      if (!this.logger) console.debug(`[PlannerTrigger] ${message}`, context);
      return;
    }
    this.logger?.debug(`[PlannerTrigger] ${message}`);
    if (!this.logger) console.debug(`[PlannerTrigger] ${message}`);
  }

  private readonly successfulTaskStatuses = new Set<TaskStatus>([
    'ready',
    'scheduling',
    'scheduled',
    'running',
    'done',
  ]);

  private updateCounters(counters: Partial<AgentCounters>): void {
    const currentCounters = this.registry?.getAgentStatus(this.agentId)?.counters;
    if (!currentCounters) {
      return;
    }

    const nextCounters: Partial<AgentCounters> = {};

    if (typeof counters.triggersAttempted === 'number') {
      nextCounters.triggersAttempted =
        (currentCounters.triggersAttempted ?? 0) + counters.triggersAttempted;
    }

    if (typeof counters.triggersSucceeded === 'number') {
      nextCounters.triggersSucceeded =
        (currentCounters.triggersSucceeded ?? 0) + counters.triggersSucceeded;
    }

    if (typeof counters.triggersFailed === 'number') {
      nextCounters.triggersFailed =
        (currentCounters.triggersFailed ?? 0) + counters.triggersFailed;
    }

    this.registry?.updateCounters(this.agentId, nextCounters);
  }

  private recordError(error: string): void {
    this.registry?.recordError(this.agentId, error);
  }

  private formatPlannerTriggerFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `Planner trigger failed before plan submission: ${message}`;
  }

  private async persistPlannerTriggerFailure(taskId: string, error: unknown): Promise<string> {
    const message = this.formatPlannerTriggerFailure(error);
    const task = this.taskRecorder.getTask(taskId);
    if (task?.status === 'planning') {
      await this.taskRecorder.recordPlannerTriggerFailure(taskId, message);
    }
    return message;
  }

  private buildMemoryContextPayload(deploymentName: string): PlannerMemoryContextPayload | null {
    if (!this.plannerMemoryStore) {
      return null;
    }

    return {
      deploymentName,
      recentEpisodes: this.plannerMemoryStore.getRecentEpisodes(deploymentName, 5),
      activeLessons: this.plannerMemoryStore.getActiveLessons(deploymentName, 3),
    };
  }

  private buildPlannerOutputFormatExample(taskId: string): PlannerOutputFormatExample {
    return {
      taskId,
      taskType: 'reconfigure',
      config: {
        replicas: 2,
        dtype: 'bf16',
        quantization: null,
        maxBatchSize: 32,
        tensorParallelism: 8,
      },
      reasoning: '<why this config was selected>',
      perfEvidence: '<historical perf evidence from tool output>',
      simulationResults: '<simulation evidence from tool output>',
      webReferences: [],
    };
  }

  async trigger(events: ValidatedEvent[], taskId: string): Promise<void> {
    this.updateCounters({ triggersAttempted: 1 });
    this.registry?.updateAgentAction(this.agentId, 'triggering planner');
    this.debug('triggering planner', {
      taskId,
      deploymentName: events[0]?.deploymentName,
      eventCount: events.length,
      metrics: events.map((e) => e.metricName),
      severities: events.map((e) => e.severity),
    });

    const payload: PlannerTriggerPayload = {
      events,
      deploymentName: events[0]?.deploymentName ?? 'unknown',
      taskId,
    };
    const memoryContext = this.buildMemoryContextPayload(payload.deploymentName);
    this.debug('planner runtime launch requested', {
      taskId,
      deploymentName: payload.deploymentName,
      recentEpisodeCount: memoryContext?.recentEpisodes.length ?? 0,
      activeLessonCount: memoryContext?.activeLessons.length ?? 0,
    });
    if (memoryContext) {
      this.debug('attaching planner memory context', {
        taskId,
        deploymentName: payload.deploymentName,
        recentEpisodeIds: memoryContext.recentEpisodes.map((episode) => episode.episodeId),
        activeLessonIds: memoryContext.activeLessons.map((lesson) => lesson.lessonId),
      });
    }
    this.debug('planner expected output format', {
      taskId,
      deploymentName: payload.deploymentName,
      outputFormat: this.buildPlannerOutputFormatExample(taskId),
    });
    this.debug('calling OpenClaw agent API', {
      agentId: this.config.agentId,
      timeoutSeconds: this.config.timeoutSeconds,
    });

    const planningResolvedPromise = this.taskRecorder.waitForTaskStatus(
      taskId,
      (event) => this.successfulTaskStatuses.has(event.currentStatus),
      this.config.timeoutSeconds * 1000,
    );

    const taskContent = [
      `Plan optimal config for the LLM deployment "${payload.deploymentName}" to address the anomalies listed in the JSON payload below.`,
      `Review ALL ${events.length} anomaly event(s) for this deployment, decide which one(s) to handle (you may ignore lower-priority ones), and submit a SINGLE plan via pimclaw_plan_task using taskId "${taskId}".`,
      memoryContext
        ? `Recent planner memory is attached separately. Use it as advisory context only; do not treat it as a substitute for Perf MCP or Simulator MCP evidence.`
        : 'No prior planner memory context is available for this deployment.',
      JSON.stringify(payload),
    ].join('\n\n');
    const attachments = [
      {
        type: 'json',
        content: JSON.stringify(payload),
      },
      ...(memoryContext
        ? [{
            type: 'json',
            content: JSON.stringify(memoryContext),
          }]
        : []),
    ];

    this.debug('planner task content prepared', {
      taskId,
      deploymentName: payload.deploymentName,
      taskContent,
    });
    this.debug('planner attachments prepared', {
      taskId,
      deploymentName: payload.deploymentName,
      attachments,
    });

    const runtimePromise = this.openclawApi.triggerAgent(this.config.agentId, {
      task: taskContent,
      mode: 'run',
      cleanup: 'delete',
      runTimeoutSeconds: this.config.timeoutSeconds,
      workspaceDir: this.config.workspaceDir,
      attachments,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const resolveSuccess = (currentStatus: TaskStatus, outcome: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.updateCounters({ triggersSucceeded: 1 });
        this.registry?.updateAgentAction(this.agentId, undefined);
        this.debug('planner trigger completed', { taskId, currentStatus, outcome });
        resolve();
      };

      const rejectFailure = async (error: unknown): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        const message = await this.persistPlannerTriggerFailure(taskId, error);
        this.updateCounters({ triggersFailed: 1 });
        this.recordError(message);
        this.registry?.updateAgentAction(this.agentId, undefined);
        this.debug('planner trigger failed', {
          taskId,
          error: message,
        });
        reject(new Error(message));
      };

      planningResolvedPromise
        .then((event) => {
          this.debug('planner task left planning', {
            taskId,
            previousStatus: event.previousStatus,
            currentStatus: event.currentStatus,
          });
          resolveSuccess(event.currentStatus, 'task status updated');
        })
        .catch((error) => {
          void rejectFailure(error);
        });

      runtimePromise
        .then(() => {
          const currentStatus = this.taskRecorder.getTask(taskId)?.status;
          if (currentStatus && this.successfulTaskStatuses.has(currentStatus)) {
            resolveSuccess(currentStatus, 'runtime completed after task advanced');
            return;
          }
          void rejectFailure(
            new Error(`Planner runtime completed before task ${taskId} left planning`),
          );
        })
        .catch((error) => {
          const currentStatus = this.taskRecorder.getTask(taskId)?.status;
          if (currentStatus && this.successfulTaskStatuses.has(currentStatus)) {
            this.debug('planner runtime failed after plan submission', {
              taskId,
              currentStatus,
              error: error instanceof Error ? error.message : String(error),
            });
            resolveSuccess(currentStatus, 'task already advanced before runtime failure');
            return;
          }
          void rejectFailure(error);
        });
    });
  }
}
