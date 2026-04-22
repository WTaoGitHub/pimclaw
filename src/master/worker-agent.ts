/**
 * Worker Agent - Task Executor
 * Executes a single task and reports results back to Task Status Recorder
 * - Spawned by Scheduler for each task
 * - Calls Engine MCP to execute actual deployment changes
 * - Reports status updates
 * - Disposed after completion
 */

import { BaseAgent } from './base-agent.js';
import { ComponentRegistry } from './component-registry.js';
import { buildPlannerMemoryEpisodeFromTask, PlannerMemoryStore } from './planner-memory-store.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { TaskExecutor } from './task-executor.js';
import { Task, AgentRuntimeStatus, TaskFeedback } from '../types/index.js';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

/**
 * Worker Agent - Executes assigned tasks
 * Ephemeral agents: one per task, disposed after completion
 */
export class WorkerAgent extends BaseAgent {
  private task: Task;
  private taskRecorder: TaskStatusRecorder;
  private taskExecutor: TaskExecutor | null;
  private plannerMemoryStore: PlannerMemoryStore | null;
  private executionTimeout: number = 30 * 60 * 1000; // 30 minutes
  private readonly logger: PluginLogger | null;

  constructor(
    registry: ComponentRegistry,
    taskRecorder: TaskStatusRecorder,
    task: Task,
    taskExecutor?: TaskExecutor,
    plannerMemoryStore?: PlannerMemoryStore,
    logger?: PluginLogger,
  ) {
    super('worker', registry, {
      agentId: `worker-${task.taskId}`,
      agentType: 'worker',
    });
    this.task = task;
    this.taskRecorder = taskRecorder;
    this.taskExecutor = taskExecutor ?? null;
    this.plannerMemoryStore = plannerMemoryStore ?? null;
    this.logger = logger ?? null;
  }

  private debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger?.debug(`[Worker] ${message}`, context);
      if (!this.logger) console.debug(`[Worker] ${message}`, context);
      return;
    }
    this.logger?.debug(`[Worker] ${message}`);
    if (!this.logger) console.debug(`[Worker] ${message}`);
  }

  private isRetryableError(errorMessage: string): boolean {
    return !errorMessage.includes('No TaskExecutor available');
  }

  private buildSuccessFeedback(result: Record<string, unknown> | null): TaskFeedback {
    const resultSignals = result ? Object.keys(result) : [];

    return {
      version: 1,
      statusSummary: 'completed-successfully',
      outcome: 'unknown',
      source: 'system',
      generatedAt: new Date(),
      summary: `Task ${this.task.taskType} completed successfully for ${this.task.llmDeploymentName}.`,
      details: resultSignals.length > 0 ? { resultSignals } : undefined,
    };
  }

  private buildFailureFeedback(statusSummary: TaskFeedback['statusSummary'], outcome: TaskFeedback['outcome'], errorMessage: string): TaskFeedback {
    return {
      version: 1,
      statusSummary,
      outcome,
      source: 'system',
      generatedAt: new Date(),
      summary: `Task ${this.task.taskType} did not complete successfully for ${this.task.llmDeploymentName}: ${errorMessage}`,
      details: {
        errorSignals: [errorMessage],
        recommendedCaution: 'Avoid repeating the same plan without reviewing the execution failure.',
      },
    };
  }

  private async syncPlannerMemory(): Promise<void> {
    if (!this.plannerMemoryStore) {
      return;
    }

    const latestTask = this.taskRecorder.getTask(this.task.taskId);
    if (!latestTask) {
      return;
    }

    this.plannerMemoryStore.upsertEpisode(buildPlannerMemoryEpisodeFromTask(latestTask));
    await this.plannerMemoryStore.flush();
  }

  /**
   * Execute the assigned task
   */
  async run(): Promise<void> {
    this.updateAction(`Executing task ${this.task.taskId}`);
    this.debug('starting', {
      taskId: this.task.taskId,
      taskType: this.task.taskType,
      deploymentName: this.task.llmDeploymentName,
      retryCount: this.task.retryCount,
      maxRetries: this.task.maxRetries,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      // Mark task as running
      await this.taskRecorder.updateTaskStatus(
        this.task.taskId,
        'running'
      );
      this.debug('task marked running', { taskId: this.task.taskId });

      // Execute the task with timeout and abort support
      const result = await Promise.race([
        this.executeTask(),
        this.createAbortableTimeout(),
      ]);

      this.debug('task execution succeeded', { taskId: this.task.taskId });

      // Mark task as completed
      await this.taskRecorder.updateTaskResult(
        this.task.taskId,
        result as Record<string, unknown> ?? {},
        null,
      );
      await this.taskRecorder.updateTaskFeedback(
        this.task.taskId,
        this.buildSuccessFeedback((result as Record<string, unknown> | null) ?? null),
      );
      await this.syncPlannerMemory();

      // Update agent counters
      const status = this.registry.getAgentStatus(this.agentId);
      if (status) {
        const tasksCompleted = (status.counters.tasksCompleted || 0) + 1;
        this.registry.updateCounters(this.agentId, { tasksCompleted });
      }

      this.updateAction('Task execution completed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const shouldRetry = !this.aborted && this.isRetryableError(errorMessage) && this.task.retryCount < this.task.maxRetries;

      // Handle abort
      if (this.aborted) {
        this.debug('task aborted', { taskId: this.task.taskId, error: errorMessage });
        await this.taskRecorder.updateTaskResult(
          this.task.taskId,
          null,
          `Task aborted: ${errorMessage}`,
        );
        await this.taskRecorder.updateTaskFeedback(
          this.task.taskId,
          this.buildFailureFeedback('execution-failed', 'failed-operationally', `Task aborted: ${errorMessage}`),
        );
        await this.syncPlannerMemory();
        this.registry.recordError(
          this.agentId,
          `Aborted task ${this.task.taskId}: ${errorMessage}`
        );
      } else if (errorMessage.includes('timeout')) {
        // Handle timeout
        this.debug('task timed out', { taskId: this.task.taskId, timeoutMs: this.executionTimeout });
        await this.taskRecorder.updateTaskResult(
          this.task.taskId,
          null,
          `Task execution timeout after ${this.executionTimeout}ms`,
        );
        await this.taskRecorder.updateTaskFeedback(
          this.task.taskId,
          this.buildFailureFeedback(
            'timed-out',
            'failed-operationally',
            `Task execution timeout after ${this.executionTimeout}ms`,
          ),
        );
        await this.syncPlannerMemory();

        // Record in agent error log
        this.registry.recordError(
          this.agentId,
          `Timeout executing task ${this.task.taskId}`
        );
      } else {
        // Handle other errors
        this.debug('task failed', { taskId: this.task.taskId, error: errorMessage });
        await this.taskRecorder.updateTaskResult(
          this.task.taskId,
          null,
          errorMessage,
        );
        if (!shouldRetry) {
          await this.taskRecorder.updateTaskFeedback(
            this.task.taskId,
            this.buildFailureFeedback('execution-failed', 'failed-operationally', errorMessage),
          );
          await this.syncPlannerMemory();
        }

        this.registry.recordError(this.agentId, errorMessage);
      }

      // Handle retry logic (skip if aborted — don't retry aborted tasks)
      if (shouldRetry) {
        // Reset task to ready for retry
        this.debug('resetting task for retry', { taskId: this.task.taskId, retryCount: this.task.retryCount, maxRetries: this.task.maxRetries });
        await this.taskRecorder.resetTaskForRetry(this.task.taskId);
      }

      // Update agent counters
      const status = this.registry.getAgentStatus(this.agentId);
      if (status) {
        const tasksFailed = (status.counters.tasksFailed || 0) + 1;
        this.registry.updateCounters(this.agentId, { tasksFailed });
      }

      this.updateAction('Task execution failed');
    } finally {
      // Always cleanup
      this.debug('shutting down', { taskId: this.task.taskId });
      await this.shutdown();
    }
  }

  /**
   * Execute the actual task via TaskExecutor → Engine MCP.
   */
  private async executeTask(): Promise<unknown> {
    this.updateAction(
      `Executing ${this.task.taskType} on ${this.task.llmDeploymentName}`
    );
    this.debug('calling task executor', {
      taskId: this.task.taskId,
      taskType: this.task.taskType,
      deploymentName: this.task.llmDeploymentName,
    });

    if (!this.taskExecutor) {
      throw new Error('No TaskExecutor available — Engine MCP not configured');
    }

    try {
      const result = await this.taskExecutor.execute(this.task);
      this.debug('task executor returned', { taskId: this.task.taskId });
      return result;
    } catch (error) {
      throw new Error(
        `Engine MCP call failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create a timeout promise that is properly cleaned up.
   * Listens to the abort signal so external abort also resolves the race.
   */
  private createAbortableTimeout(): Promise<never> {
    return new Promise<never>((_, reject) => {
      // If already aborted, reject immediately
      if (this.abortController.signal.aborted) {
        reject(new Error('Task aborted before execution'));
        return;
      }

      const timer = setTimeout(
        () => reject(new Error(`timeout: Task exceeded ${this.executionTimeout}ms limit`)),
        this.executionTimeout,
      );

      // Track the timer for cleanup
      this.trackResource('execution-timeout', async () => {
        clearTimeout(timer);
      });

      // Listen for abort signal
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error(`Task aborted: ${this.abortController.signal.reason ?? 'no reason'}`));
      };
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Get worker-specific runtime status
   */
  getRuntimeStatus(): AgentRuntimeStatus | undefined {
    const baseStatus = super.getRuntimeStatus();
    if (!baseStatus) return undefined;
    return {
      ...baseStatus,
      counters: {
        ...baseStatus.counters,
        taskId: this.task.taskId,
        taskStatus: this.task.status,
      },
    };
  }
}
