/**
 * PimClaw v2 E2E: integration boundary + components.
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { ComponentRegistry } from '../master/component-registry.js';
import { TaskStatusRecorder } from '../master/task-status-recorder.js';
import { SchedulerAgent } from '../master/scheduler-agent.js';
import { PlannerTrigger } from '../master/planner-trigger.js';
import { AnomalyReceiver } from '../master/anomaly-receiver.js';

describe('PimClaw v2 integration', () => {
  it('creates planning task from anomaly and transitions to ready after planning', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-v2-'));

    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const triggerCalls: Array<{ taskId: string }> = [];
    const plannerApi = {
      triggerAgent: async (_agentId: string, options: any) => {
        const payload = JSON.parse(options.attachments?.[0]?.content ?? '{}');
        triggerCalls.push({ taskId: payload.taskId });
      },
    };

    const plannerTrigger = new PlannerTrigger(plannerApi as any, {
      agentId: 'pimclaw-planner',
      timeoutSeconds: 600,
    });
    const anomalyReceiver = new AnomalyReceiver(recorder, plannerTrigger);

    const events = [
      {
        type: 'spike' as const,
        metricName: 'ttft',
        currentValue: 500,
        previousValue: 150,
        severity: 'high' as const,
        deploymentName: 'llama-70b-prod',
        reasoning: 'TTFT spike with QPS increase',
      },
    ];

    const accepted = await anomalyReceiver.receive(events);
    expect(accepted).toHaveLength(1);

    const taskId = accepted[0].taskId;
    const planningTask = recorder.getTask(taskId);
    expect(planningTask?.status).toBe('planning');
    expect(triggerCalls).toHaveLength(1);

    planningTask!.taskType = 'scale-up';
    planningTask!.config = { replicas: 3, dtype: 'fp16' };
    planningTask!.reasoning = 'Historical and simulated data support scale-up';
    await recorder.updateTaskStatus(taskId, 'ready');

    expect(recorder.getTask(taskId)?.status).toBe('ready');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scheduler picks up ready task after planning', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-v2-scheduler-'));

    const registry = new ComponentRegistry();
    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const scheduler = new SchedulerAgent(registry, recorder, 2);
    await scheduler.initialize();

    const taskId = uuidv4();
    await recorder.createTask({
      taskId,
      status: 'ready',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: 'high',
      llmDeploymentName: 'llama-70b-prod',
      taskType: 'scale-up',
      taskData: {},
      config: { replicas: 3, dtype: 'fp16' },
      reasoning: 'Planner recommendation',
      retryCount: 0,
      maxRetries: 3,
    });

    await (scheduler as any).schedulingCycle();

    const task = recorder.getTask(taskId);
    expect(['scheduling', 'scheduled']).toContain(task?.status);

    await scheduler.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
