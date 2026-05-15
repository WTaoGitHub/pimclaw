import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { ComponentRegistry } from '../master/component-registry.js';
import { PlannerMemoryStore } from '../master/planner-memory-store.js';
import { TaskStatusRecorder } from '../master/task-status-recorder.js';
import { WorkerAgent } from '../master/worker-agent.js';

describe('WorkerAgent retries', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-worker-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('does not retry when Engine MCP is not configured', async () => {
    const registry = new ComponentRegistry();
    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const taskId = uuidv4();
    await recorder.createTask({
      taskId,
      status: 'scheduled',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'high',
      llmDeploymentName: 'minimax-m27',
      taskType: 'restart',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    const worker = new WorkerAgent(registry, recorder, recorder.getTask(taskId)!);
    await worker.initialize();
    await worker.run();

    const storedTask = recorder.getTask(taskId)!;
    expect(storedTask.status).toBe('failed');
    expect(storedTask.retryCount).toBe(0);
    expect(storedTask.error).toContain('No TaskExecutor available');
    expect(storedTask.feedback?.outcome).toBe('failed-operationally');
    expect(storedTask.feedback?.statusSummary).toBe('execution-failed');
  });

  it('keeps retrying transient executor failures', async () => {
    const registry = new ComponentRegistry();
    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const taskId = uuidv4();
    await recorder.createTask({
      taskId,
      status: 'scheduled',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'high',
      llmDeploymentName: 'minimax-m25-tp8ep',
      taskType: 'restart',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    const failingExecutor = {
      execute: async () => {
        throw new Error('upstream engine unavailable');
      },
    } as any;

    const worker = new WorkerAgent(
      registry,
      recorder,
      recorder.getTask(taskId)!,
      failingExecutor,
    );
    await worker.initialize();
    await worker.run();

    const storedTask = recorder.getTask(taskId)!;
    expect(storedTask.status).toBe('ready');
    expect(storedTask.retryCount).toBe(1);
    expect(storedTask.error).toBeUndefined();
    expect(storedTask.feedback).toBeUndefined();
  });

  it('writes initial feedback for successful task execution', async () => {
    const registry = new ComponentRegistry();
    const recorder = new TaskStatusRecorder(tmpDir);
    const plannerMemoryStore = new PlannerMemoryStore(tmpDir);
    await recorder.initialize();
    await plannerMemoryStore.load();

    const taskId = uuidv4();
    await recorder.createTask({
      taskId,
      status: 'scheduled',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'high',
      llmDeploymentName: 'minimax-m26',
      taskType: 'scale-up',
      taskData: {},
      retryCount: 0,
      maxRetries: 3,
    });

    const successfulExecutor = {
      execute: async () => ({
        success: true,
        taskType: 'scale-up',
        serviceId: 'svc-1',
        after: { replicas: 2 },
      }),
    } as any;

    const worker = new WorkerAgent(
      registry,
      recorder,
      recorder.getTask(taskId)!,
      successfulExecutor,
      plannerMemoryStore,
    );
    await worker.initialize();
    await worker.run();

    const storedTask = recorder.getTask(taskId)!;
    expect(storedTask.status).toBe('done');
    expect(storedTask.feedback?.statusSummary).toBe('completed-successfully');
    expect(storedTask.feedback?.source).toBe('system');
    expect(storedTask.feedback?.summary).toContain('completed successfully');
    expect(storedTask.feedback?.details?.resultSignals).toContain('success');
    expect(storedTask.feedback?.details?.resultSignals).toContain('after');

    const reloadedMemoryStore = new PlannerMemoryStore(tmpDir);
    await reloadedMemoryStore.load();
    expect(reloadedMemoryStore.getRecentEpisodes('minimax-m26', 1)[0]?.taskId).toBe(taskId);
  });
});