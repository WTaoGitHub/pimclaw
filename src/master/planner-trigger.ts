/**
 * PlannerTrigger — spawns a Planner agent via OpenClaw API
 * for each validated anomaly event.
 */

import type { ValidatedEvent } from './anomaly-receiver.js';

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

const DEFAULT_CONFIG: PlannerTriggerConfig = {
  agentId: 'pimclaw-planner',
  timeoutSeconds: 600,
};

export class PlannerTrigger {
  private openclawApi: OpenClawAgentApi;
  private config: PlannerTriggerConfig;

  constructor(openclawApi: OpenClawAgentApi, config?: Partial<PlannerTriggerConfig>) {
    this.openclawApi = openclawApi;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async trigger(event: ValidatedEvent, taskId: string): Promise<void> {
    await this.openclawApi.triggerAgent(this.config.agentId, {
      task: `Plan optimal config for anomaly: ${event.reasoning || event.type + ' on ' + event.metricName}`,
      mode: 'run',
      cleanup: 'delete',
      runTimeoutSeconds: this.config.timeoutSeconds,
      workspaceDir: this.config.workspaceDir,
      attachments: [{
        type: 'json',
        content: JSON.stringify({ event, taskId }),
      }],
    });
  }
}
