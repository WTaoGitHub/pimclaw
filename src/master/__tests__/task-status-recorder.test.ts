/**
 * TaskStatusRecorder Tests
 * Validates task persistence, state machine, and stale task cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStatusRecorder } from '../../master/task-status-recorder.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

describe('TaskStatusRecorder', () => {
  let recorder: TaskStatusRecorder;
  const testDir = path.join('./test-data', `recorder-${uuidv4()}`);

  beforeEach(async () => {
    // Create isolated test environment
    await fs.mkdir(testDir, { recursive: true });
    recorder = new TaskStatusRecorder();
    // Override storage path for testing
    (recorder as any).storagePath = testDir;
    await recorder.initialize();
  });

  afterEach(async () => {
    // Cleanup test data
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should create a new task', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: { factor: 2 },
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    const retrieved = recorder.getTask(task.taskId);

    expect(retrieved).toBeDefined();
    expect(retrieved?.taskId).toBe(task.taskId);
    expect(retrieved?.status).toBe('ready');
  });

  it('should update task status', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    await recorder.updateTaskStatus(task.taskId, 'scheduling');

    const updated = recorder.getTask(task.taskId);
    expect(updated?.status).toBe('scheduling');
    expect(updated?.statusModifiedAt.getTime()).toBeGreaterThanOrEqual(
      task.createdAt.getTime()
    );
  });

  it('should retrieve tasks by status', async () => {
    const readyTask1 = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'high' as const,
      llmDeploymentName: 'deployment-1',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    const readyTask2 = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'low' as const,
      llmDeploymentName: 'deployment-2',
      taskType: 'scale-down',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    const schedulingTask = {
      taskId: uuidv4(),
      status: 'scheduling' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'deployment-3',
      taskType: 'restart',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(readyTask1);
    await recorder.createTask(readyTask2);
    await recorder.createTask(schedulingTask);

    const readyTasks = recorder.getTasksByStatus('ready');
    expect(readyTasks).toHaveLength(2);
    expect(readyTasks.every((t) => t.status === 'ready')).toBe(true);

    const schedulingTasks = recorder.getTasksByStatus('scheduling');
    expect(schedulingTasks).toHaveLength(1);
  });

  it('should update task result', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'running' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    await recorder.updateTaskResult(task.taskId, {
      status: 'done',
      result: { newScale: 4, executedAt: new Date() },
    });

    const updated = recorder.getTask(task.taskId);
    expect(updated?.status).toBe('done');
    expect(updated?.result).toBeDefined();
    expect((updated?.result as any).newScale).toBe(4);
  });

  it('should persist tasks to file', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(task);
    await recorder.persist();

    const tasksFile = path.join(testDir, 'tasks.json');
    const content = await fs.readFile(tasksFile, 'utf-8');
    const parsed = JSON.parse(content);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((t: any) => t.taskId === task.taskId)).toBe(true);
  });

  it('should get task counts', async () => {
    // Create tasks with different statuses
    const statusTasks: Record<string, any[]> = {
      ready: [],
      scheduling: [],
      scheduled: [],
      running: [],
    };

    for (const status of Object.keys(statusTasks)) {
      for (let i = 0; i < 2; i++) {
        const task = {
          taskId: uuidv4(),
          status: status as any,
          createdAt: new Date(),
          statusModifiedAt: new Date(),
          priority: 'medium' as const,
          llmDeploymentName: `deployment-${status}-${i}`,
          taskType: 'scale-up',
          taskData: {},
          retryCount: 0,
          maxRetries: 3,
        };
        statusTasks[status].push(task);
        await recorder.createTask(task);
      }
    }

    const counts = recorder.getTaskCounts();

    expect(counts.ready).toBe(2);
    expect(counts.scheduling).toBe(2);
    expect(counts.scheduled).toBe(2);
    expect(counts.running).toBe(2);
  });

  it('should mark stale ready tasks as expired on initialize', async () => {
    // Create an old ready task (created 2 minutes ago)
    const oldTask = {
      taskId: uuidv4(),
      status: 'ready' as const,
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
      statusModifiedAt: new Date(Date.now() - 2 * 60 * 1000),
      priority: 'medium' as const,
      llmDeploymentName: 'old-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    };

    await recorder.createTask(oldTask);
    await recorder.persist();

    // Create new recorder instance (should trigger cleanup)
    const newRecorder = new TaskStatusRecorder();
    (newRecorder as any).storagePath = testDir;
    await newRecorder.initialize();

    const task = newRecorder.getTask(oldTask.taskId);
    expect(task?.status).toBe('expired');
  });

  it('should reset task for retry', async () => {
    const task = {
      taskId: uuidv4(),
      status: 'failed' as const,
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium' as const,
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 1,
      maxRetries: 3,
      error: 'Previous execution failed',
    };

    await recorder.createTask(task as any);
    await recorder.resetTaskForRetry(task.taskId);

    const reset = recorder.getTask(task.taskId);
    expect(reset?.status).toBe('ready');
    expect(reset?.retryCount).toBe(2);
    expect(reset?.error).toBeUndefined();
  });
});
