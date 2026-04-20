/**
 * PlannerTrigger — spawns a Planner agent via OpenClaw API
 * for each validated anomaly event.
 */

import type { ValidatedEvent } from './anomaly-receiver.js';
import type { ComponentRegistry } from './component-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import type { TaskStatus } from '../types/index.js';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

export interface OpenClawAgentApi {
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

const DEFAULT_CONFIG: PlannerTriggerConfig = {
  agentId: 'pimclaw-planner',
  timeoutSeconds: 600,
};

export class PlannerTrigger {
  private readonly taskRecorder: TaskStatusRecorder;
  private openclawApi: OpenClawAgentApi;
  private config: PlannerTriggerConfig;
  private readonly registry: ComponentRegistry | null;
  private readonly logger: PluginLogger | null;
  private readonly agentId = 'planner-trigger';

  constructor(openclawApi: OpenClawAgentApi, taskRecorder: TaskStatusRecorder, config?: Partial<PlannerTriggerConfig>, registry?: ComponentRegistry, logger?: PluginLogger) {
    this.openclawApi = openclawApi;
    this.taskRecorder = taskRecorder;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = registry ?? null;
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

  async trigger(events: ValidatedEvent[], taskId: string): Promise<void> {
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
    this.debug('calling OpenClaw agent API', {
      agentId: this.config.agentId,
      timeoutSeconds: this.config.timeoutSeconds,
    });

    const planningResolvedPromise = this.taskRecorder.waitForTaskStatus(
      taskId,
      (event) => this.successfulTaskStatuses.has(event.currentStatus),
      this.config.timeoutSeconds * 1000,
    );

    const runtimePromise = this.openclawApi.triggerAgent(this.config.agentId, {
      task: [
        `Plan optimal config for the LLM deployment "${payload.deploymentName}" to address the anomalies listed in the JSON payload below.`,
        `Review ALL ${events.length} anomaly event(s) for this deployment, decide which one(s) to handle (you may ignore lower-priority ones), and submit a SINGLE plan via pimclaw_plan_task using taskId "${taskId}".`,
        JSON.stringify(payload),
      ].join('\n\n'),
      mode: 'run',
      cleanup: 'delete',
      runTimeoutSeconds: this.config.timeoutSeconds,
      workspaceDir: this.config.workspaceDir,
      attachments: [{
        type: 'json',
        content: JSON.stringify(payload),
      }],
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const resolveSuccess = (currentStatus: TaskStatus): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.debug('planner trigger completed', { taskId, currentStatus });
        resolve();
      };

      const rejectFailure = async (error: unknown): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        const message = await this.persistPlannerTriggerFailure(taskId, error);
        reject(new Error(message));
      };

      planningResolvedPromise
        .then((event) => {
          resolveSuccess(event.currentStatus);
        })
        .catch((error) => {
          void rejectFailure(error);
        });

      runtimePromise
        .then(() => {
          const currentStatus = this.taskRecorder.getTask(taskId)?.status;
          if (currentStatus && this.successfulTaskStatuses.has(currentStatus)) {
            resolveSuccess(currentStatus);
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
            resolveSuccess(currentStatus);
            return;
          }
          void rejectFailure(error);
        });
    });
  }
}
