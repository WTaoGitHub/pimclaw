/**
 * Task Status Recorder Agent - Central task state manager for PimClaw
 * Persists tasks, manages state transitions, and exposes an API for Scheduler and Workers
 */

import { Task, TaskStatus } from '../types/index.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Central task state manager
 * Stores tasks persistently and manages their lifecycle
 */
export class TaskStatusRecorder {
  private tasks: Map<string, Task> = new Map();
  private readonly storagePath: string;
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

  constructor(storagePath: string = './pimclaw-tasks') {
    this.storagePath = storagePath;
  }

  /**
   * Initialize the recorder, loading persisted tasks from storage
   */
  async initialize(): Promise<void> {
    try {
      const tasksFile = path.join(this.storagePath, 'tasks.json');
      const data = await fs.readFile(tasksFile, 'utf-8');
      const loadedTasks = JSON.parse(data) as Record<string, Task>;

      // Restore tasks and mark stale ones as expired
      const now = new Date();
      for (const [id, task] of Object.entries(loadedTasks)) {
        // Mark ready tasks as expired if older than 1 min
        if (
          task.status === 'ready' &&
          now.getTime() - new Date(task.createdAt).getTime() > 60000
        ) {
          task.status = 'expired';
          task.statusModifiedAt = now;
        }

        // Mark scheduling tasks as expired if status unchanged for >30s
        if (
          task.status === 'scheduling' &&
          now.getTime() - new Date(task.statusModifiedAt).getTime() > 30000
        ) {
          task.status = 'expired';
          task.statusModifiedAt = now;
        }

        // Mark planning tasks as expired if status unchanged for >10min
        if (
          task.status === 'planning' &&
          now.getTime() - new Date(task.statusModifiedAt).getTime() > 600000
        ) {
          task.status = 'expired';
          task.statusModifiedAt = now;
        }

        this.tasks.set(id, task);
      }

      await this.persist();
    } catch {
      // No stored file yet, start fresh
      await fs.mkdir(this.storagePath, { recursive: true });
    }
  }

  /**
   * Create a new task
   */
  async createTask(task: Task): Promise<void> {
    this.tasks.set(task.taskId, task);
    await this.persist();
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
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

    if (task.status !== newStatus) {
      const validNext = this.allowedTransitions[task.status] || [];
      if (!validNext.includes(newStatus)) {
        throw new Error(
          `Invalid status transition for task ${taskId}: ${task.status} -> ${newStatus}`,
        );
      }
    }

    task.status = newStatus;
    task.statusModifiedAt = new Date();
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
    await fs.writeFile(tasksFile, JSON.stringify(tasksObj, null, 2), 'utf-8');
  }
}
