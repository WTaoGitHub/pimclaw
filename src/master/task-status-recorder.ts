/**
 * Task Status Recorder Agent - Central task state manager for PimClaw
 * Persists tasks, manages state transitions, and exposes an API for Scheduler and Workers
 */

import { Task, TaskStatus } from '../types/index.js';
import { ComponentRegistry } from './component-registry.js';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';
import fs from 'fs/promises';
import path from 'path';

interface TaskStatusWaitEvent {
  taskId: string;
  previousStatus: TaskStatus;
  currentStatus: TaskStatus;
  task: Task;
}

interface TaskStatusWaiter {
  taskId: string;
  predicate: (event: TaskStatusWaitEvent) => boolean;
  resolve: (event: TaskStatusWaitEvent) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Central task state manager
 * Stores tasks persistently and manages their lifecycle
 */
export class TaskStatusRecorder {
  private tasks: Map<string, Task> = new Map();
  private readonly statusWaiters: Set<TaskStatusWaiter> = new Set();
  private readonly storagePath: string;
  private readonly registry: ComponentRegistry | null;
  private readonly logger: PluginLogger | null;
  private readonly agentId = 'task-status-recorder';
  private readonly allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
    planning: ['ready', 'expired'],
    ready: ['scheduling', 'expired'],
    scheduling: ['scheduled', 'expired'],
    scheduled: ['running', 'expired'],
    running: ['done', 'failed', 'expired'],
    done: [],
    failed: ['ready', 'expired'],
    expired: [],
  };

  constructor(storagePath: string = './pimclaw-tasks', registry?: ComponentRegistry, logger?: PluginLogger) {
    this.storagePath = storagePath;
    this.registry = registry ?? null;
    this.logger = logger ?? null;
  }

  private debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger?.debug(`[TaskStatusRecorder] ${message}`, context);
      if (!this.logger) console.debug(`[TaskStatusRecorder] ${message}`, context);
      return;
    }
    this.logger?.debug(`[TaskStatusRecorder] ${message}`);
    if (!this.logger) console.debug(`[TaskStatusRecorder] ${message}`);
  }

  private emitStatusTransition(taskId: string, previousStatus: TaskStatus, currentStatus: TaskStatus, task: Task): void {
    const event: TaskStatusWaitEvent = {
      taskId,
      previousStatus,
      currentStatus,
      task,
    };

    for (const waiter of Array.from(this.statusWaiters)) {
      if (waiter.taskId !== taskId) {
        continue;
      }
      if (!waiter.predicate(event)) {
        continue;
      }

      this.statusWaiters.delete(waiter);
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
      }
      waiter.resolve(event);
    }
  }

  /**
   * Initialize the recorder, loading persisted tasks from storage
   */
  async initialize(): Promise<void> {
    this.debug('initializing', { storagePath: this.storagePath });

    // Register with ComponentRegistry if provided
    if (this.registry) {
      this.registry.registerAgent({
        agentId: this.agentId,
        agentType: 'recorder',
        status: 'Starting',
        startedAt: new Date(),
        lastActivityAt: new Date(),
        mcpConnections: {},
        counters: { totalTasks: 0, readyTasks: 0, runningTasks: 0, doneTasks: 0, failedTasks: 0, expiredTasks: 0 },
        errors: { errorCount: 0, lastError: undefined, lastErrorAt: undefined },
      });
    }

    try {
      const tasksFile = path.join(this.storagePath, 'tasks.json');
      const data = await fs.readFile(tasksFile, 'utf-8');
      const loadedTasks = JSON.parse(data) as Record<string, Task>;

      // Restore tasks and mark stale ones as expired
      const now = new Date();
      let expiredCount = 0;
      for (const [id, task] of Object.entries(loadedTasks)) {
        // Mark ready tasks as expired if older than 1 min
        if (
          task.status === 'ready' &&
          now.getTime() - new Date(task.createdAt).getTime() > 60000
        ) {
          task.status = 'expired';
          task.statusModifiedAt = now;
          expiredCount++;
        }

        // Mark scheduling tasks as expired if status unchanged for >30s
        if (
          task.status === 'scheduling' &&
          now.getTime() - new Date(task.statusModifiedAt).getTime() > 30000
        ) {
          task.status = 'expired';
          task.statusModifiedAt = now;
          expiredCount++;
        }

        // Mark planning tasks as expired if status unchanged for >10min
        if (
          task.status === 'planning' &&
          now.getTime() - new Date(task.statusModifiedAt).getTime() > 600000
        ) {
          task.status = 'expired';
          task.statusModifiedAt = now;
          expiredCount++;
        }

        this.tasks.set(id, task);
      }

      this.debug('loaded persisted tasks', { total: this.tasks.size, expiredOnLoad: expiredCount });
      await this.persist();
    } catch {
      // No stored file yet, start fresh
      this.debug('no persisted tasks found, starting fresh');
      await fs.mkdir(this.storagePath, { recursive: true });
    }

    // Mark as active
    if (this.registry) {
      this.registry.updateAgentStatus(this.agentId, 'Listening');
    }
  }

  /**
   * Create a new task
   */
  async createTask(task: Task): Promise<void> {
    this.debug('creating task', { taskId: task.taskId, status: task.status });
    this.tasks.set(task.taskId, task);
    await this.persist();
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  async waitForTaskStatus(
    taskId: string,
    predicate: (event: TaskStatusWaitEvent) => boolean,
    timeoutMs?: number,
  ): Promise<TaskStatusWaitEvent> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const currentEvent: TaskStatusWaitEvent = {
      taskId,
      previousStatus: task.status,
      currentStatus: task.status,
      task,
    };
    if (predicate(currentEvent)) {
      return currentEvent;
    }

    return new Promise<TaskStatusWaitEvent>((resolve, reject) => {
      const waiter: TaskStatusWaiter = {
        taskId,
        predicate,
        resolve,
        reject,
      };

      if (timeoutMs && timeoutMs > 0) {
        waiter.timeoutHandle = setTimeout(() => {
          this.statusWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for task ${taskId} status change`));
        }, timeoutMs);
      }

      this.statusWaiters.add(waiter);
    });
  }

  /**
   * Get all tasks with a specific status
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Update task status
   */
  async updateTaskStatus(taskId: string, newStatus: TaskStatus): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const oldStatus = task.status;
    if (oldStatus !== newStatus) {
      const validNext = this.allowedTransitions[oldStatus] || [];
      if (!validNext.includes(newStatus)) {
        throw new Error(
          `Invalid status transition for task ${taskId}: ${oldStatus} -> ${newStatus}`,
        );
      }
    }

    this.debug('status transition', { taskId, from: oldStatus, to: newStatus });
    task.status = newStatus;
    task.statusModifiedAt = new Date();
    await this.persist();
    this.emitStatusTransition(taskId, oldStatus, newStatus, task);
  }

  async recordPlannerTriggerFailure(taskId: string, error: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.plannerTriggerError = error;
    task.plannerTriggerErrorAt = new Date();
    this.debug('planner trigger failure recorded', { taskId, error });
    await this.persist();
  }

  /**
   * Update task with result or error
   */
  async updateTaskResult(
    taskId: string,
    result: Record<string, unknown> | null,
    error: string | null
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (result) {
      task.result = result;
      task.status = 'done';
    }
    if (error) {
      task.error = error;
      task.status = 'failed';
    }
    this.debug('task result updated', { taskId, outcome: result ? 'done' : 'failed' });
    task.completedAt = new Date();
    task.statusModifiedAt = new Date();
    await this.persist();
  }

  /**
   * Reset a task for retry
   */
  async resetTaskForRetry(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (task.retryCount >= task.maxRetries) {
      throw new Error(
        `Task ${taskId} has exceeded max retries (${task.maxRetries})`
      );
    }
    task.status = 'ready';
    task.retryCount++;
    this.debug('task reset for retry', { taskId, retryCount: task.retryCount, maxRetries: task.maxRetries });
    task.statusModifiedAt = new Date();
    task.result = undefined;
    task.error = undefined;
    task.completedAt = undefined;
    await this.persist();
  }

  /**
   * Get task count by status
   */
  getTaskCounts(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      planning: 0,
      ready: 0,
      scheduling: 0,
      scheduled: 0,
      running: 0,
      done: 0,
      failed: 0,
      expired: 0,
    };

    for (const task of this.tasks.values()) {
      counts[task.status]++;
    }

    return counts;
  }

  /**
   * Persist all tasks to storage
   */
  async persist(): Promise<void> {
    const tasksObj: Record<string, Task> = {};
    for (const [id, task] of this.tasks) {
      tasksObj[id] = task;
    }
    const tasksFile = path.join(this.storagePath, 'tasks.json');
    this.debug('persisting tasks', { count: this.tasks.size });
    await fs.writeFile(tasksFile, JSON.stringify(tasksObj, null, 2), 'utf-8');
  }
}
