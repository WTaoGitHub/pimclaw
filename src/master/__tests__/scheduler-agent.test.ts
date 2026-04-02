/**
 * SchedulerAgent Tests
 * Validates task scheduling, concurrency limiting, and timeout enforcement
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SchedulerAgent } from '../../master/scheduler-agent.js';
import { AgentRegistry } from '../../master/agent-registry.js';
import { TaskStatusRecorder } from '../../master/task-status-recorder.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

describe('SchedulerAgent', () => {
  let scheduler: SchedulerAgent;
  let registry: AgentRegistry;
  let taskRecorder: TaskStatusRecorder;
  const testDir = path.join('./test-data', `scheduler-${uuidv4()}`);

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });

    registry = new AgentRegistry();
    taskRecorder = new TaskStatusRecorder();
    (taskRecorder as any).storagePath = testDir;
    await taskRecorder.initialize();

    scheduler = new SchedulerAgent(registry, taskRecorder);
    (scheduler as any).snapshotInterval = 100; // Fast polling for tests
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should fetch ready tasks up to concurrency limit', async () => {
    // Create 15 ready tasks
    const taskIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const taskId = uuidv4();
      taskIds.push(taskId);
      await taskRecorder.createTask({
        taskId,
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

    // Simulate scheduling one cycle
    const scheduled = await (scheduler as any).schedulingCycle();

    // Should schedule up to maxConcurrentWorkers (default 10)
    expect((scheduler as any).activeWorkers.size).toBeLessThanOrEqual(10);
  });

  it('should not exceed max concurrent workers', async () => {
    // Set max workers to 3
    (scheduler as any).maxConcurrentWorkers = 3;

    // Create 10 ready tasks
    for (let i = 0; i < 10; i++) {
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

    // Run scheduling cycle
    await (scheduler as any).schedulingCycle();

    // Should not exceed limit
    expect((scheduler as any).activeWorkers.size).toBeLessThanOrEqual(3);
  });

  it('should mark expired ready tasks as expired', async () => {
    // Create an old ready task (created 2 minutes ago)
    const oldTaskId = uuidv4();
    await taskRecorder.createTask({
      taskId: oldTaskId,
      status: 'ready',
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
      statusModifiedAt: new Date(Date.now() - 2 * 60 * 1000),
      priority: 'medium',
      llmDeploymentName: 'old-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    // Create a fresh ready task
    const freshTaskId = uuidv4();
    await taskRecorder.createTask({
      taskId: freshTaskId,
      status: 'ready',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium',
      llmDeploymentName: 'fresh-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    // Run scheduling cycle
    await (scheduler as any).schedulingCycle();

    // Old task should be expired
    const oldTask = taskRecorder.getTask(oldTaskId);
    expect(oldTask?.status).toBe('expired');

    // Fresh task should remain ready or be scheduled
    const freshTask = taskRecorder.getTask(freshTaskId);
    expect(['ready', 'scheduling']).toContain(freshTask?.status);
  });

  it('should mark stale scheduling tasks as expired', async () => {
    // Create a scheduling task that has been pending for 31 seconds
    const stallTaskId = uuidv4();
    const stallTime = new Date(Date.now() - 31 * 1000);
    await taskRecorder.createTask({
      taskId: stallTaskId,
      status: 'scheduling',
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
      statusModifiedAt: stallTime,
      priority: 'medium',
      llmDeploymentName: 'stall-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    // Run scheduling cycle
    await (scheduler as any).schedulingCycle();

    // Task should be expired
    const task = taskRecorder.getTask(stallTaskId);
    expect(task?.status).toBe('expired');
  });

  it('should update counters on task scheduling', async () => {
    // Create a ready task
    const taskId = uuidv4();
    await taskRecorder.createTask({
      taskId,
      status: 'ready',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium',
      llmDeploymentName: 'deployment-1',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    // Register scheduler in registry
    registry.registerAgent({
      agentId: 'scheduler-1',
      agentType: 'scheduler',
      status: 'Listening',
      counters: { tasksScheduled: 0, activeWorkers: 0 },
      errors: [],
      mcpConnections: {},
      startedAt: new Date(),
    });

    // Run scheduling cycle
    await (scheduler as any).schedulingCycle();

    // Check counters
    const status = registry.getAgentStatus('scheduler-1');
    expect(status?.counters.tasksScheduled || 0).toBeGreaterThan(0);
  });

  it('should handle task completion', async () => {
    const taskId = uuidv4();

    // Simulate a completed task
    await scheduler.taskCompleted(taskId);

    // Task should be removed from active workers
    expect((scheduler as any).activeWorkers.has(taskId)).toBe(false);
  });

  it('should handle task failure with retry', async () => {
    const taskId = uuidv4();

    // Create a task with retries available
    await taskRecorder.createTask({
      taskId,
      status: 'running',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium',
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    // Simulate task failure
    await scheduler.taskFailed(taskId, 'Test failure');

    // Task should be reset to ready for retry
    const task = taskRecorder.getTask(taskId);
    expect(task?.status).toBe('ready');
    expect(task?.retryCount).toBe(1);
    expect(task?.error).toBe('Test failure');

    // Task should be removed from active workers
    expect((scheduler as any).activeWorkers.has(taskId)).toBe(false);
  });

  it('should handle task failure without retry', async () => {
    const taskId = uuidv4();

    // Create a task at max retries
    await taskRecorder.createTask({
      taskId,
      status: 'running',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'medium',
      llmDeploymentName: 'test-deployment',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 3,
      maxRetries: 3,
    });

    // Simulate task failure
    await scheduler.taskFailed(taskId, 'Final failure');

    // Task should be marked as failed
    const task = taskRecorder.getTask(taskId);
    expect(task?.status).toBe('failed');
  });

  it('should track active workers correctly', async () => {
    const taskId1 = uuidv4();
    const taskId2 = uuidv4();

    // Add workers
    (scheduler as any).activeWorkers.add(taskId1);
    (scheduler as any).activeWorkers.add(taskId2);

    expect((scheduler as any).activeWorkers.size).toBe(2);

    // Complete one task
    await scheduler.taskCompleted(taskId1);

    expect((scheduler as any).activeWorkers.size).toBe(1);
    expect((scheduler as any).activeWorkers.has(taskId2)).toBe(true);
  });

  it('should initialize with correct polling interval', () => {
    expect((scheduler as any).pollingIntervalMs).toBe(5 * 1000);
  });

  it('should initialize with correct max concurrent workers', () => {
    expect((scheduler as any).maxConcurrentWorkers).toBe(10);
  });

  it('should register itself in the registry on initialize', async () => {
    await scheduler.initialize();

    const status = registry.getAgentStatus(scheduler.agentId);
    expect(status).toBeDefined();
    expect(status?.agentType).toBe('scheduler');
  });
});
