/**
 * Fake Prometheus Task Executor — test-only remediation adapter.
 *
 * Calls the fake Prometheus server's /_fake/action endpoint so end-to-end tests
 * can close the loop: metrics anomaly -> plan -> worker action -> remediated
 * fake metrics.
 */

import { Task } from '../types/index.js';
import type { TaskRunner, TaskExecutionResult } from './task-executor.js';

export interface FakePrometheusTaskExecutorConfig {
  baseUrl: string;
  timeoutMs?: number;
}

export class FakePrometheusTaskExecutor implements TaskRunner {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: FakePrometheusTaskExecutorConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async execute(task: Task): Promise<TaskExecutionResult> {
    const action = this.mapTaskTypeToAction(task.taskType);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/_fake/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          taskType: task.taskType,
          deploymentName: task.llmDeploymentName,
        }),
        signal: controller.signal,
      });

      const responseText = await response.text();
      const responseBody = this.parseResponseBody(responseText);

      if (!response.ok) {
        throw new Error(
          `Fake Prometheus remediation failed with HTTP ${response.status}: ${responseText}`,
        );
      }

      return {
        success: true,
        taskType: task.taskType,
        serviceId: task.llmDeploymentName,
        after: {
          action,
          fakePrometheus: responseBody,
        },
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Fake Prometheus remediation timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapTaskTypeToAction(taskType: string): string {
    switch (taskType) {
      case 'restart':
        return 'restart';
      case 'reconfigure':
        return 'reconfigure';
      case 'scale-up':
        return 'scale-out';
      case 'scale-down':
        return 'scale-in';
      default:
        throw new Error(`Unsupported fake remediation task type: ${taskType}`);
    }
  }

  private parseResponseBody(text: string): Record<string, unknown> {
    if (!text.trim()) {
      return {};
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }
}
