/**
 * AnomalyReceiver — validates events from the LLM Head Agent
 * and triggers the Planner for each validated event.
 *
 * Hooks are non-fatal: if a hook throws, the error is logged and
 * processing continues. Hooks can return { preventContinuation: true }
 * to skip the Planner trigger for a given event.
 */

import { TaskStatusRecorder } from './task-status-recorder.js';
import { PlannerTrigger } from './planner-trigger.js';
import { ComponentRegistry } from './component-registry.js';
import { Task } from '../types/index.js';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';
import { v4 as uuidv4 } from 'uuid';

export interface AnomalyEvent {
  type: 'spike' | 'drop' | 'trend' | 'anomaly';
  metricName: string;
  currentValue: number;
  previousValue?: number;
  severity: 'high' | 'medium' | 'low';
  deploymentName: string;
  reasoning?: string;
}

export interface ValidatedEvent extends AnomalyEvent {
  eventId: string;
  receivedAt: Date;
  taskId: string;
  hookDurationMs?: number;
}

export interface AnomalyReceiverConfig {
  maxEventsPerSubmission: number;
  deduplicationWindowMs: number;
  planningTimeoutMs: number;
  allowedMetrics: string[];
}

export interface HookResult {
  preventContinuation?: boolean;
}

export interface AnomalyReceiverHooks {
  onPlanningTaskCreated?: (taskId: string, event: ValidatedEvent) => HookResult | void | Promise<HookResult | void>;
  onPlannerTriggerFailed?: (taskId: string, event: ValidatedEvent, error: unknown) => void | Promise<void>;
}

const DEFAULT_CONFIG: AnomalyReceiverConfig = {
  maxEventsPerSubmission: 20,
  deduplicationWindowMs: 600_000,
  planningTimeoutMs: 600_000,
  allowedMetrics: ['ttft', 'tpot', 'qps', 'throughput', 'gpu_utilization', 'error_rate'],
};

export class AnomalyReceiver {
  private taskRecorder: TaskStatusRecorder;
  private plannerTrigger: PlannerTrigger;
  private config: AnomalyReceiverConfig;
  private hooks: AnomalyReceiverHooks;
  private recentEvents: Map<string, Date> = new Map();
  private readonly registry: ComponentRegistry | null;
  private readonly agentId = 'anomaly-receiver';
  private readonly logger: PluginLogger | null;

  constructor(
    taskRecorder: TaskStatusRecorder,
    plannerTrigger: PlannerTrigger,
    config?: Partial<AnomalyReceiverConfig>,
    hooks?: AnomalyReceiverHooks,
    registry?: ComponentRegistry,
    logger?: PluginLogger,
  ) {
    this.taskRecorder = taskRecorder;
    this.plannerTrigger = plannerTrigger;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hooks = hooks ?? {};
    this.registry = registry ?? null;
    this.logger = logger ?? null;

    if (this.registry) {
      this.registry.registerAgent({
        agentId: this.agentId,
        agentType: 'receiver',
        status: 'Listening',
        startedAt: new Date(),
        lastActivityAt: new Date(),
        mcpConnections: {},
        counters: { eventsReceived: 0, eventsValidated: 0, eventsRejected: 0, eventsDeduplicated: 0 },
        errors: { errorCount: 0, lastError: undefined, lastErrorAt: undefined },
      });
    }

    this.debug('initialized', {
      maxEventsPerSubmission: this.config.maxEventsPerSubmission,
      deduplicationWindowMs: this.config.deduplicationWindowMs,
      planningTimeoutMs: this.config.planningTimeoutMs,
      allowedMetrics: this.config.allowedMetrics,
    });
  }

  async receive(events: AnomalyEvent[]): Promise<ValidatedEvent[]> {
    this.debug('receive called', { submittedEvents: Array.isArray(events) ? events.length : 'invalid' });

    if (!Array.isArray(events) || events.length === 0) {
      this.debug('receive rejected: empty or invalid events payload');
      throw new Error('Events array must be non-empty');
    }

    if (events.length > this.config.maxEventsPerSubmission) {
      this.debug('receive rejected: submission exceeds configured maximum', {
        submittedEvents: events.length,
        maxEventsPerSubmission: this.config.maxEventsPerSubmission,
      });
      throw new Error(
        `Too many events: ${events.length} exceeds max ${this.config.maxEventsPerSubmission}`,
      );
    }

    const validated: ValidatedEvent[] = [];

    for (const event of events) {
      this.debug('processing event', {
        metricName: event.metricName,
        deploymentName: event.deploymentName,
        severity: event.severity,
        type: event.type,
      });

      const error = this.validateEvent(event);
      if (error) {
        this.debug('event rejected by validation', {
          metricName: event.metricName,
          deploymentName: event.deploymentName,
          reason: error,
        });
        continue; // skip invalid events
      }

      const dedupKey = `${event.metricName}:${event.deploymentName}`;
      if (this.isDuplicate(dedupKey)) {
        this.debug('event deduplicated', {
          dedupKey,
          metricName: event.metricName,
          deploymentName: event.deploymentName,
        });
        continue; // skip duplicate events
      }

      const taskId = uuidv4();
      const validatedEvent: ValidatedEvent = {
        ...event,
        eventId: uuidv4(),
        receivedAt: new Date(),
        taskId,
      };

      // Create a preliminary task in 'planning' state
      const task: Task = {
        taskId,
        status: 'planning',
        createdAt: new Date(),
        statusModifiedAt: new Date(),
        priority: event.severity === 'high' ? 'high' : 'medium',
        llmDeploymentName: event.deploymentName,
        taskType: 'pending-plan', // will be updated by Planner
        taskData: {
          eventId: validatedEvent.eventId,
          eventType: event.type,
          metric: event.metricName,
          currentValue: event.currentValue,
          previousValue: event.previousValue,
          reasoning: event.reasoning,
        },
        retryCount: 0,
        maxRetries: 3,
      };

      await this.taskRecorder.createTask(task);
      this.recentEvents.set(dedupKey, new Date());
      this.debug('planning task created', {
        taskId,
        eventId: validatedEvent.eventId,
        dedupKey,
        deploymentName: event.deploymentName,
        metricName: event.metricName,
      });

      // Run hook (non-fatal: errors are logged, not propagated)
      let skipPlanner = false;
      const hookStart = Date.now();
      try {
        const hookResult = await this.hooks.onPlanningTaskCreated?.(taskId, validatedEvent);
        if (hookResult?.preventContinuation) {
          skipPlanner = true;
          this.debug('planner trigger skipped by onPlanningTaskCreated hook', {
            taskId,
            eventId: validatedEvent.eventId,
          });
        }
      } catch (hookError) {
        this.error(`onPlanningTaskCreated hook error for task ${taskId}:`, hookError);
      }
      validatedEvent.hookDurationMs = Date.now() - hookStart;
      this.debug('planning hook completed', {
        taskId,
        eventId: validatedEvent.eventId,
        hookDurationMs: validatedEvent.hookDurationMs,
        skipPlanner,
      });

      // Trigger the Planner agent asynchronously (unless hook prevented it)
      if (!skipPlanner) {
        this.debug('triggering planner', {
          taskId,
          eventId: validatedEvent.eventId,
          deploymentName: validatedEvent.deploymentName,
          metricName: validatedEvent.metricName,
        });
        this.plannerTrigger
          .trigger(validatedEvent, taskId)
          .catch(async (error) => {
            this.debug('planner trigger failed', {
              taskId,
              eventId: validatedEvent.eventId,
              error: error instanceof Error ? error.message : String(error),
            });
            try {
              await this.hooks.onPlannerTriggerFailed?.(taskId, validatedEvent, error);
            } catch (hookError) {
              this.error(`onPlannerTriggerFailed hook error for task ${taskId}:`, hookError);
            }
          });
      }

      validated.push(validatedEvent);
    }

    this.cleanupStaleDedup();
    this.debug('receive completed', {
      submittedEvents: events.length,
      acceptedEvents: validated.length,
      dedupCacheSize: this.recentEvents.size,
    });

    return validated;
  }

  private validateEvent(event: AnomalyEvent): string | null {
    const validTypes = ['spike', 'drop', 'trend', 'anomaly'];
    if (!validTypes.includes(event.type)) {
      return `Invalid event type: ${event.type}`;
    }

    const validSeverities = ['high', 'medium', 'low'];
    if (!validSeverities.includes(event.severity)) {
      return `Invalid severity: ${event.severity}`;
    }

    if (!this.config.allowedMetrics.includes(event.metricName)) {
      return `Invalid metric: ${event.metricName}`;
    }

    if (typeof event.currentValue !== 'number' || !isFinite(event.currentValue) || event.currentValue < 0) {
      return `Invalid currentValue: ${event.currentValue}`;
    }

    if (event.previousValue !== undefined) {
      if (typeof event.previousValue !== 'number' || !isFinite(event.previousValue) || event.previousValue < 0) {
        return `Invalid previousValue: ${event.previousValue}`;
      }
    }

    if (!event.deploymentName || typeof event.deploymentName !== 'string') {
      return 'Missing or invalid deploymentName';
    }

    return null;
  }

  private isDuplicate(dedupKey: string): boolean {
    const lastSeen = this.recentEvents.get(dedupKey);
    if (!lastSeen) return false;
    return Date.now() - lastSeen.getTime() < this.config.deduplicationWindowMs;
  }

  private cleanupStaleDedup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, date] of this.recentEvents) {
      if (now - date.getTime() > this.config.deduplicationWindowMs) {
        this.recentEvents.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.debug('cleaned stale dedup entries', {
        removed,
        remaining: this.recentEvents.size,
      });
    }
  }

  private debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger?.debug(`[AnomalyReceiver] ${message}`, context);
      if (!this.logger) {
        console.debug(`[AnomalyReceiver] ${message}`, context);
      }
      return;
    }

    this.logger?.debug(`[AnomalyReceiver] ${message}`);
    if (!this.logger) {
      console.debug(`[AnomalyReceiver] ${message}`);
    }
  }

  private error(message: string, error: unknown): void {
    this.logger?.error(`[AnomalyReceiver] ${message}`, error);
    if (!this.logger) {
      console.error(`[AnomalyReceiver] ${message}`, error);
    }
  }
}
