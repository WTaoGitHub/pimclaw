import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { TaskStatusRecorder } from '../task-status-recorder.js';
import { PlannerTrigger } from '../planner-trigger.js';
import { ComponentRegistry } from '../component-registry.js';

function createPlanningTask(taskId: string) {
  return {
    taskId,
    status: 'planning' as const,
    createdAt: new Date(),
    statusModifiedAt: new Date(),
    priority: 'medium' as const,
    llmDeploymentName: 'minimax-m25-tp8ep',
    taskType: 'pending-plan',
    taskData: {},
    retryCount: 0,
    maxRetries: 3,
  };
}

describe('PlannerTrigger completion semantics', () => {
  it('resolves when the task leaves planning before the planner process exits', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-planner-trigger-'));
    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const taskId = uuidv4();
    await recorder.createTask(createPlanningTask(taskId));

    let releaseRuntime: (() => void) | undefined;
    const plannerApi = {
      triggerAgent: async () => {
        await new Promise<void>((resolve) => {
          releaseRuntime = resolve;
        });
      },
    };

    const trigger = new PlannerTrigger(plannerApi as any, recorder, {
      timeoutSeconds: 1,
    });

    let resolved = false;
    const triggerPromise = trigger.trigger([
      {
        type: 'spike',
        metricName: 'tpot',
        currentValue: 0.19,
        previousValue: 0.099,
        severity: 'medium',
        deploymentName: 'minimax-m25-tp8ep',
        taskId,
        eventId: uuidv4(),
        receivedAt: new Date(),
      },
    ], taskId).then(() => {
      resolved = true;
    });

    await recorder.updateTaskStatus(taskId, 'ready');
    // Give it a few ticks/ms to process the watcher event
    await new Promise(r => setTimeout(r, 100));

    expect(resolved).toBe(true);

    releaseRuntime?.();
    await triggerPromise;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('records planner startup failure on the task before rejecting', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-planner-trigger-'));
    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const taskId = uuidv4();
    await recorder.createTask(createPlanningTask(taskId));

    const trigger = new PlannerTrigger({
      triggerAgent: async () => {
        throw new Error('no resource available for creating planner');
      },
    }, recorder, {
      timeoutSeconds: 1,
    });

    await expect(trigger.trigger([
      {
        type: 'spike',
        metricName: 'tpot',
        currentValue: 0.19,
        previousValue: 0.099,
        severity: 'medium',
        deploymentName: 'minimax-m25-tp8ep',
        taskId,
        eventId: uuidv4(),
        receivedAt: new Date(),
      },
    ], taskId)).rejects.toThrow(/Planner trigger failed before plan submission/);

    const task = recorder.getTask(taskId)!;
    expect(task.status).toBe('planning');
    expect(task.plannerTriggerError).toContain('no resource available for creating planner');
    expect(task.plannerTriggerErrorAt).toBeDefined();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('updates registry counters for successful and failed planner triggers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-planner-trigger-'));
    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const registry = new ComponentRegistry();
    let releaseRuntime: (() => void) | undefined;
    const triggerAgent = vi.fn(async () => {
      if (releaseRuntime) {
        throw new Error('planner offline');
      }

      await new Promise<void>((resolve) => {
        releaseRuntime = resolve;
      });
    });
    const trigger = new PlannerTrigger({
      triggerAgent,
    }, recorder, { timeoutSeconds: 1 }, registry);

    const successTaskId = uuidv4();
    await recorder.createTask(createPlanningTask(successTaskId));

    const successPromise = trigger.trigger([
      {
        type: 'spike',
        metricName: 'tpot',
        currentValue: 0.19,
        previousValue: 0.099,
        severity: 'medium',
        deploymentName: 'minimax-m25-tp8ep',
        taskId: successTaskId,
        eventId: uuidv4(),
        receivedAt: new Date(),
      },
    ], successTaskId);

    await recorder.updateTaskStatus(successTaskId, 'ready');
    releaseRuntime?.();
    await successPromise;

    const failureTaskId = uuidv4();
    await recorder.createTask(createPlanningTask(failureTaskId));

    await expect(trigger.trigger([
      {
        type: 'spike',
        metricName: 'tpot',
        currentValue: 0.19,
        previousValue: 0.099,
        severity: 'medium',
        deploymentName: 'minimax-m25-tp8ep',
        taskId: failureTaskId,
        eventId: uuidv4(),
        receivedAt: new Date(),
      },
    ], failureTaskId)).rejects.toThrow(/Planner trigger failed before plan submission/);

    const status = registry.getAgentStatus('planner-trigger');
    expect(triggerAgent).toHaveBeenCalledTimes(2);
    expect(status?.counters.triggersAttempted).toBe(2);
    expect(status?.counters.triggersSucceeded).toBe(1);
    expect(status?.counters.triggersFailed).toBe(1);
    expect(status?.errors.lastError).toContain('planner offline');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});