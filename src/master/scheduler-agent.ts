/**
 * Scheduler Agent - Manages task scheduling and Worker Agent creation
 * Implements concurrency limiting, task expiry enforcement, and abort propagation
 */

import { BaseAgent } from './base-agent.js';
import { ComponentRegistry } from './component-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { WorkerAgent } from './worker-agent.js';
import { Task } from '../types/index.js';

/**
 * Scheduler Agent
 * Bridges planned tasks and Worker execution
 * - Fetches ready tasks from Task Status Recorder
 * - Creates ephemeral Worker Agents
 * - Enforces concurrency limits and timeouts
 * - Propagates abort to child Workers on shutdown
 */
export class SchedulerAgent extends BaseAgent {
  private taskRecorder: TaskStatusRecorder;
  private maxConcurrentWorkers: number = 10;
  private workers: Map<string, WorkerAgent> = new Map();
  private pollingIntervalMs: number = 5000; // poll every 5 seconds
  private isRunning: boolean = false;

  constructor(
    registry: ComponentRegistry,
    taskRecorder: TaskStatusRecorder,
    maxWorkers?: number
  ) {
    super('scheduler', registry, {
      agentId: 'scheduler-1',
      agentType: 'scheduler',
    });
    this.taskRecorder = taskRecorder;
    if (maxWorkers) {
      this.maxConcurrentWorkers = maxWorkers;
    }
  }

  /**
   * Main scheduler loop
   */
  async run(): Promise<void> {
    this.isRunning = true;
    this.updateAction('Starting polling loop');

    while (this.isRunning && this.status === 'Listening' && !this.aborted) {
      try {
        await this.schedulingCycle();
        await this.sleep(this.pollingIntervalMs);
      } catch (error) {
        if (this.aborted) break;
        this.registry.recordError(
          this.agentId,
          `Scheduler error: ${error instanceof Error ? error.message : String(error)}`
        );
        await this.sleep(this.pollingIntervalMs);
      }
    }
  }

  /**
   * Single scheduling cycle
   */
  private async schedulingCycle(): Promise<void> {
    this.updateAction('Polling for ready tasks');

    // Get current task counts
    const counts = this.taskRecorder.getTaskCounts();
    const availableSlots =
      this.maxConcurrentWorkers - this.workers.size;

    if (availableSlots <= 0) {
      this.updateAction(
        `At capacity: ${this.workers.size}/${this.maxConcurrentWorkers} workers active`
      );
      return;
    }

    // Fetch up to availableSlots ready tasks
    const readyTasks = this.taskRecorder
      .getTasksByStatus('ready')
      .slice(0, availableSlots);

    for (const task of readyTasks) {
      await this.scheduleTask(task);
    }

    // Update counters
    this.registry.updateCounters(this.agentId, {
      activeWorkers: this.workers.size,
      maxWorkers: this.maxConcurrentWorkers,
      tasksScheduled: readyTasks.length,
    });
  }

  /**
   * Schedule a single task
   */
  private async scheduleTask(task: Task): Promise<void> {
    try {
      // Check if task has expired while waiting
      if (
        task.status === 'ready' &&
        new Date().getTime() - new Date(task.createdAt).getTime() > 60000
      ) {
        await this.taskRecorder.updateTaskStatus(task.taskId, 'expired');
        return;
      }

      // Update to scheduling
      await this.taskRecorder.updateTaskStatus(task.taskId, 'scheduling');
      this.updateAction(`Scheduling task ${task.taskId}`);

      // Create and track a Worker Agent
      const worker = new WorkerAgent(this.registry, this.taskRecorder, task);
      this.workers.set(task.taskId, worker);

      // Initialize worker (registers in registry, attempts MCP connections)
      await worker.initialize();

      // Update status to scheduled
      await this.taskRecorder.updateTaskStatus(task.taskId, 'scheduled');

      // Run worker in background; remove from map when done
      worker.run().finally(() => {
        this.workers.delete(task.taskId);
      });

      console.log(`[Scheduler] Scheduled task ${task.taskId}`);
    } catch (error) {
      this.registry.recordError(
        this.agentId,
        `Failed to schedule task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the number of active workers
   */
  get activeWorkerCount(): number {
    return this.workers.size;
  }

  /**
   * Mark a task as completed (called by Worker)
   */
  async taskCompleted(taskId: string, result: Record<string, unknown>): Promise<void> {
    this.workers.delete(taskId);
    await this.taskRecorder.updateTaskResult(taskId, result, null);
    const tasksRescheduled =
      (this.registry.getAgentStatus(this.agentId)?.counters.tasksRescheduled || 0) + 1;
    this.registry.updateCounters(this.agentId, { tasksRescheduled });
  }

  /**
   * Mark a task as failed (called by Worker)
   */
  async taskFailed(taskId: string, error: string): Promise<void> {
    this.workers.delete(taskId);
    const task = this.taskRecorder.getTask(taskId);
    if (task && task.retryCount < task.maxRetries) {
      // Retry: reset to ready
      await this.taskRecorder.resetTaskForRetry(taskId);
    } else {
      // Give up: mark as failed
      await this.taskRecorder.updateTaskResult(taskId, null, error);
    }
  }

  /**
   * Stop the scheduler and abort all child workers
   */
  async shutdown(): Promise<void> {
    this.isRunning = false;

    // Abort all child workers before shutting down
    for (const [taskId, worker] of this.workers) {
      worker.abort('parent scheduler shutting down');
    }

    await super.shutdown();
  }

  /**
   * Sleep helper — resolves immediately if abort signal fires.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.aborted) { resolve(); return; }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
