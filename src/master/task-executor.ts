/**
 * Task Executor — Maps PimClaw task types to qianjin-xuntui MCP tool call sequences.
 *
 * Supported task types:
 *   - scale-up:     get_service → update_service(replicas += N) → restart_service
 *   - scale-down:   get_service → update_service(replicas -= N) → restart_service
 *   - restart:      restart_service
 *   - reconfigure:  get_service → update_service(changed fields) → restart_service
 */

import { EngineMcpClient } from './engine-mcp-client.js';
import { Task } from '../types/index.js';

export interface TaskExecutionResult {
  success: boolean;
  taskType: string;
  serviceId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: string;
}

export interface TaskRunner {
  execute(task: Task): Promise<TaskExecutionResult>;
}

export class TaskExecutor implements TaskRunner {
  private engineClient: EngineMcpClient;
  private serviceIdCache: Map<string, string> = new Map();

  constructor(engineClient: EngineMcpClient) {
    this.engineClient = engineClient;
  }

  /**
   * Execute a task by dispatching to the appropriate handler.
   */
  async execute(task: Task): Promise<TaskExecutionResult> {
    const serviceId = await this.resolveServiceId(task.llmDeploymentName);

    switch (task.taskType) {
      case 'scale-up':
        return this.executeScaleUp(serviceId, task);
      case 'scale-down':
        return this.executeScaleDown(serviceId, task);
      case 'restart':
        return this.executeRestart(serviceId, task);
      case 'reconfigure':
        return this.executeReconfigure(serviceId, task);
      default:
        throw new Error(`Unknown task type: ${task.taskType}`);
    }
  }

  /**
   * Resolve a deployment name to a serviceId via model_deploy_list_services.
   * Results are cached to avoid repeated lookups.
   */
  async resolveServiceId(deploymentName: string): Promise<string> {
    const cached = this.serviceIdCache.get(deploymentName);
    if (cached) return cached;

    const data = await this.engineClient.callTool('model_deploy_list_services', {}) as Record<string, unknown>;
    const services: any[] = (data.items ?? data.data ?? data.list ?? []) as any[];

    if (!Array.isArray(services)) {
      throw new Error('Unexpected response from model_deploy_list_services');
    }

    const match = services.find((s: any) =>
      s.serviceName === deploymentName ||
      s.name === deploymentName ||
      String(s.serviceId) === deploymentName ||
      String(s.id) === deploymentName ||
      s.serviceName?.includes(deploymentName) ||
      s.name?.includes(deploymentName),
    );

    if (!match) {
      throw new Error(
        `Service not found for deployment "${deploymentName}". ` +
        `Available: ${services.map((s: any) => s.serviceName ?? s.name).join(', ')}`,
      );
    }

    const serviceId = String(match.serviceId ?? match.id);
    this.serviceIdCache.set(deploymentName, serviceId);
    return serviceId;
  }

  clearServiceIdCache(): void {
    this.serviceIdCache.clear();
  }

  // ── Task type handlers ────────────────────────────────────────────────────

  private async executeScaleUp(serviceId: string, task: Task): Promise<TaskExecutionResult> {
    const before = await this.getServiceConfig(serviceId);
    const currentReplicas = this.extractReplicas(before);
    const delta = Number(task.config?.replicaDelta ?? task.config?.replicas ?? 1);
    const newReplicas = currentReplicas + delta;

    await this.engineClient.callTool('model_deploy_update_service', {
      serviceId,
      replicas: newReplicas,
    });

    await this.engineClient.callTool('model_deploy_restart_service', {
      ids: serviceId,
    });

    const after = await this.waitForServiceReady(serviceId);

    return {
      success: true,
      taskType: 'scale-up',
      serviceId,
      before: { replicas: currentReplicas },
      after: { replicas: newReplicas, ...this.extractSummary(after) },
    };
  }

  private async executeScaleDown(serviceId: string, task: Task): Promise<TaskExecutionResult> {
    const before = await this.getServiceConfig(serviceId);
    const currentReplicas = this.extractReplicas(before);
    const delta = Number(task.config?.replicaDelta ?? task.config?.replicas ?? 1);
    const newReplicas = Math.max(1, currentReplicas - delta);

    if (newReplicas === currentReplicas) {
      return {
        success: true,
        taskType: 'scale-down',
        serviceId,
        before: { replicas: currentReplicas },
        after: { replicas: currentReplicas },
      };
    }

    await this.engineClient.callTool('model_deploy_update_service', {
      serviceId,
      replicas: newReplicas,
    });

    await this.engineClient.callTool('model_deploy_restart_service', {
      ids: serviceId,
    });

    const after = await this.waitForServiceReady(serviceId);

    return {
      success: true,
      taskType: 'scale-down',
      serviceId,
      before: { replicas: currentReplicas },
      after: { replicas: newReplicas, ...this.extractSummary(after) },
    };
  }

  private async executeRestart(serviceId: string, _task: Task): Promise<TaskExecutionResult> {
    const before = await this.getServiceConfig(serviceId);

    await this.engineClient.callTool('model_deploy_restart_service', {
      ids: serviceId,
    });

    const after = await this.waitForServiceReady(serviceId);

    return {
      success: true,
      taskType: 'restart',
      serviceId,
      before: this.extractSummary(before),
      after: this.extractSummary(after),
    };
  }

  private async executeReconfigure(serviceId: string, task: Task): Promise<TaskExecutionResult> {
    const before = await this.getServiceConfig(serviceId);

    const updateArgs: Record<string, unknown> = { serviceId };
    const configFieldMap: Record<string, string> = {
      replicas: 'replicas',
      cpu: 'cpu',
      memory: 'memory',
      gpuCount: 'gpuCount',
      command: 'command',
      serviceName: 'serviceName',
    };

    for (const [configKey, mcpKey] of Object.entries(configFieldMap)) {
      if (task.config?.[configKey] !== undefined) {
        updateArgs[mcpKey] = task.config[configKey];
      }
    }

    await this.engineClient.callTool('model_deploy_update_service', updateArgs);

    await this.engineClient.callTool('model_deploy_restart_service', {
      ids: serviceId,
    });

    const after = await this.waitForServiceReady(serviceId);

    return {
      success: true,
      taskType: 'reconfigure',
      serviceId,
      before: this.extractSummary(before),
      after: this.extractSummary(after),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getServiceConfig(serviceId: string): Promise<Record<string, unknown>> {
    return await this.engineClient.callTool('model_deploy_get_service', { serviceId }) as Record<string, unknown>;
  }

  /**
   * Poll service status until running (status=1) or timeout.
   */
  private async waitForServiceReady(
    serviceId: string,
    maxWaitMs = 120_000,
    intervalMs = 5_000,
  ): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const svc = await this.getServiceConfig(serviceId);
      // status 1 = running per workflow.md
      if (svc.status === 1 || svc.status === '1' || svc.statusName === 'running') {
        return svc;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    // Return last state even if not ready yet
    return await this.getServiceConfig(serviceId);
  }

  private extractReplicas(svc: Record<string, unknown>): number {
    return Number(svc.replicas ?? svc.replicaCount ?? 1);
  }

  private extractSummary(svc: Record<string, unknown>): Record<string, unknown> {
    return {
      status: svc.status,
      statusName: svc.statusName,
      replicas: svc.replicas ?? svc.replicaCount,
      cpu: svc.cpu,
      memory: svc.memory,
      gpuCount: svc.gpuCount,
    };
  }
}
