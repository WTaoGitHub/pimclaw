/**
 * PlannerTrigger — spawns a Planner agent via OpenClaw API
 * for each validated anomaly event.
 */

import type { ValidatedEvent } from './anomaly-receiver.js';
import type { ComponentRegistry } from './component-registry.js';
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
  private openclawApi: OpenClawAgentApi;
  private config: PlannerTriggerConfig;
  private readonly registry: ComponentRegistry | null;
  private readonly logger: PluginLogger | null;
  private readonly agentId = 'planner-trigger';

  constructor(openclawApi: OpenClawAgentApi, config?: Partial<PlannerTriggerConfig>, registry?: ComponentRegistry, logger?: PluginLogger) {
    this.openclawApi = openclawApi;
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

    await this.openclawApi.triggerAgent(this.config.agentId, {
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

    this.debug('planner trigger completed', { taskId });
  }
}
