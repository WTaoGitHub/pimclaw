/**
 * SchedulerAgent Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SchedulerAgent } from '../../master/scheduler-agent.js';
import { ComponentRegistry } from '../../master/component-registry.js';
import { TaskStatusRecorder } from '../../master/task-status-recorder.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

describe('SchedulerAgent', () => {
  let scheduler: SchedulerAgent;
  let registry: ComponentRegistry;
  let taskRecorder: TaskStatusRecorder;
  const testDir = path.join('./test-data', `scheduler-${uuidv4()}`);

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    registry = new ComponentRegistry();
    taskRecorder = new TaskStatusRecorder(testDir);
    await taskRecorder.initialize();

    scheduler = new SchedulerAgent(registry, taskRecorder, 3);
    await scheduler.initialize();
  });

  afterEach(async () => {
    await scheduler.shutdown();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('schedules ready tasks up to concurrency limit', async () => {
    for (let i = 0; i < 5; i++) {
      await taskRecorder.createTask({
        taskId: uuidv4(),
        status: 'ready',
        createdAt: new Date(),
        statusModifiedAt: new Date(),
        priority: 'medium',
        llmDeploymentName: `deployment-${i}`,
        taskType: 'scale-up',
        taskData: {},
        retryCount: 0,
        maxRetries: 3,
      });
    }

    await (scheduler as any).schedulingCycle();

    const allTasks = taskRecorder.getAllTasks();
    const scheduledLike = allTasks.filter(
      (t) => t.status === 'scheduling' || t.status === 'scheduled'
    );
    expect(scheduledLike.length).toBeLessThanOrEqual(3);
  });

  it('completes a task and records done result', async () => {
    const taskId = uuidv4();
    await taskRecorder.createTask({
      taskId,
      status: 'running',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium',
      llmDeploymentName: 'deployment-a',
      taskType: 'restart',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    await scheduler.taskCompleted(taskId, { ok: true });
    const task = taskRecorder.getTask(taskId);

    expect(task?.status).toBe('done');
    expect(task?.result).toEqual({ ok: true });
  });

  it('resets failed task for retry when retries remain', async () => {
    const taskId = uuidv4();
    await taskRecorder.createTask({
      taskId,
      status: 'running',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium',
      llmDeploymentName: 'deployment-b',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    await scheduler.taskFailed(taskId, 'transient failure');
    const task = taskRecorder.getTask(taskId);

    expect(task?.status).toBe('ready');
    expect(task?.retryCount).toBe(1);
  });
});
