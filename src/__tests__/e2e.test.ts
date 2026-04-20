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
      workspaceDir: '/tmp/pimclaw-planner-workspace',
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
    expect(triggerCalls[0].taskId).toBe(taskId);

    planningTask!.taskType = 'scale-up';
    planningTask!.config = { replicas: 3, dtype: 'fp16' };
    planningTask!.reasoning = 'Historical and simulated data support scale-up';
    await recorder.updateTaskStatus(taskId, 'ready');

    expect(recorder.getTask(taskId)?.status).toBe('ready');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('groups anomalies by deployment — one task and one planner call per deployment', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-v2-multidev-'));

    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();

    const triggerCalls: Array<{ taskId: string; deploymentName: string; eventCount: number }> = [];
    const plannerApi = {
      triggerAgent: async (_agentId: string, options: any) => {
        const payload = JSON.parse(options.attachments?.[0]?.content ?? '{}');
        triggerCalls.push({
          taskId: payload.taskId,
          deploymentName: payload.deploymentName,
          eventCount: (payload.events as unknown[]).length,
        });
      },
    };

    const plannerTrigger = new PlannerTrigger(plannerApi as any, {
      agentId: 'pimclaw-planner',
      timeoutSeconds: 600,
      workspaceDir: '/tmp/pimclaw-planner-workspace',
    });
    const anomalyReceiver = new AnomalyReceiver(recorder, plannerTrigger);

    // 2 anomalies for deployment-A, 3 anomalies for deployment-B
    const events = [
      { type: 'spike' as const, metricName: 'ttft',             currentValue: 500, severity: 'high' as const,   deploymentName: 'deployment-A' },
      { type: 'spike' as const, metricName: 'gpu_utilization',  currentValue: 96,  severity: 'high' as const,   deploymentName: 'deployment-A' },
      { type: 'drop'  as const, metricName: 'qps',              currentValue: 2,   severity: 'medium' as const, deploymentName: 'deployment-B' },
      { type: 'spike' as const, metricName: 'error_rate',       currentValue: 8,   severity: 'high' as const,   deploymentName: 'deployment-B' },
      { type: 'spike' as const, metricName: 'tpot',             currentValue: 300, severity: 'medium' as const, deploymentName: 'deployment-B' },
    ];

    const accepted = await anomalyReceiver.receive(events);

    // All 5 events accepted
    expect(accepted).toHaveLength(5);

    // Exactly 2 Planner invocations — one per deployment, not one per event
    expect(triggerCalls).toHaveLength(2);

    const callA = triggerCalls.find((c) => c.deploymentName === 'deployment-A');
    const callB = triggerCalls.find((c) => c.deploymentName === 'deployment-B');

    expect(callA).toBeDefined();
    expect(callA!.eventCount).toBe(2);

    expect(callB).toBeDefined();
    expect(callB!.eventCount).toBe(3);

    // Exactly 2 planning tasks created — one per deployment
    const allTasks = recorder.getAllTasks();
    expect(allTasks).toHaveLength(2);

    const taskIds = new Set(accepted.map((e) => e.taskId));
    expect(taskIds.size).toBe(2); // all events for same deployment share one taskId

    // All events for deployment-A share one taskId
    const taskIdA = accepted.find((e) => e.deploymentName === 'deployment-A')!.taskId;
    const allAShareTaskId = accepted
      .filter((e) => e.deploymentName === 'deployment-A')
      .every((e) => e.taskId === taskIdA);
    expect(allAShareTaskId).toBe(true);

    // All events for deployment-B share a different taskId
    const taskIdB = accepted.find((e) => e.deploymentName === 'deployment-B')!.taskId;
    expect(taskIdB).not.toBe(taskIdA);
    const allBShareTaskId = accepted
      .filter((e) => e.deploymentName === 'deployment-B')
      .every((e) => e.taskId === taskIdB);
    expect(allBShareTaskId).toBe(true);

    // Task for deployment-A has high priority (has a high-severity event)
    expect(recorder.getTask(taskIdA)?.priority).toBe('high');
    // Task for deployment-B also has high priority (error_rate is high)
    expect(recorder.getTask(taskIdB)?.priority).toBe('high');

    // Task data contains all events for that deployment
    const taskDataA = recorder.getTask(taskIdA)?.taskData as any;
    expect(taskDataA.events).toHaveLength(2);

    const taskDataB = recorder.getTask(taskIdB)?.taskData as any;
    expect(taskDataB.events).toHaveLength(3);

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
    // Worker now actually runs: task may have advanced past scheduled to running/failed
    expect(['scheduling', 'scheduled', 'running', 'failed']).toContain(task?.status);

    await scheduler.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
