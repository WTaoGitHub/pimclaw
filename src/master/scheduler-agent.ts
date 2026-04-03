/**
 * Scheduler Agent - Manages task scheduling and Worker Agent creation
 * Implements concurrency limiting and task expiry enforcement
 */

import { BaseAgent } from './base-agent.js';
import { ComponentRegistry } from './component-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { Task } from '../types/index.js';

/**
 * Scheduler Agent
 * Bridges planned tasks and Worker execution
 * - Fetches ready tasks from Task Status Recorder
 * - Creates ephemeral Worker Agents
 * - Enforces concurrency limits and timeouts
 */
export class SchedulerAgent extends BaseAgent {
  private taskRecorder: TaskStatusRecorder;
  private maxConcurrentWorkers: number = 10;
  private activeWorkers: Set<string> = new Set(); // task IDs of running workers
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

    while (this.isRunning && this.status === 'Listening') {
      try {
        await this.schedulingCycle();
        await this.sleep(this.pollingIntervalMs);
      } catch (error) {
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
      this.maxConcurrentWorkers - this.activeWorkers.size;

    if (availableSlots <= 0) {
      this.updateAction(
        `At capacity: ${this.activeWorkers.size}/${this.maxConcurrentWorkers} workers active`
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
      activeWorkers: this.activeWorkers.size,
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

      // Create a Worker Agent (TODO: implement Worker class)
      // For now, just track it as scheduled
      this.activeWorkers.add(task.taskId);

      // Update status to scheduled
      await this.taskRecorder.updateTaskStatus(task.taskId, 'scheduled');

      console.log(`[Scheduler] Scheduled task ${task.taskId}`);
    } catch (error) {
      this.registry.recordError(
        this.agentId,
        `Failed to schedule task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Mark a task as completed (called by Worker)
   */
  async taskCompleted(taskId: string, result: Record<string, unknown>): Promise<void> {
    this.activeWorkers.delete(taskId);
    await this.taskRecorder.updateTaskResult(taskId, result, null);
    const tasksRescheduled =
      (this.registry.getAgentStatus(this.agentId)?.counters.tasksRescheduled || 0) + 1;
    this.registry.updateCounters(this.agentId, { tasksRescheduled });
  }

  /**
   * Mark a task as failed (called by Worker)
   */
  async taskFailed(taskId: string, error: string): Promise<void> {
    this.activeWorkers.delete(taskId);
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
   * Stop the scheduler
   */
  async shutdown(): Promise<void> {
    this.isRunning = false;
    await super.shutdown();
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
