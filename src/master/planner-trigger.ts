/**
 * PlannerTrigger — spawns a Planner agent via OpenClaw API
 * for each validated anomaly event.
 */

import type { ValidatedEvent } from './anomaly-receiver.js';
import type { ComponentRegistry } from './component-registry.js';

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
  event: ValidatedEvent;
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
  private readonly agentId = 'planner-trigger';

  constructor(openclawApi: OpenClawAgentApi, config?: Partial<PlannerTriggerConfig>, registry?: ComponentRegistry) {
    this.openclawApi = openclawApi;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = registry ?? null;

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

  async trigger(event: ValidatedEvent, taskId: string): Promise<void> {
    const payload: PlannerTriggerPayload = { event, taskId };
    await this.openclawApi.triggerAgent(this.config.agentId, {
      task: [
        'Plan optimal config for the anomaly described in the JSON payload below.',
        'Use the payload values as the authoritative input.',
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
  }
}
