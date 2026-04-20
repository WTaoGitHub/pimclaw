/**
 * AnomalyReceiver Tests
 * Validates event validation, deduplication, rate limiting, and Planner triggering
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnomalyReceiver } from '../../master/anomaly-receiver.js';
import type { AnomalyEvent } from '../../master/anomaly-receiver.js';
import { TaskStatusRecorder } from '../../master/task-status-recorder.js';
import { PlannerTrigger } from '../../master/planner-trigger.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('AnomalyReceiver', () => {
  let receiver: AnomalyReceiver;
  let taskRecorder: TaskStatusRecorder;
  let plannerTrigger: PlannerTrigger;
  let triggerSpy: ReturnType<typeof vi.fn>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-anomaly-'));

    taskRecorder = new TaskStatusRecorder(tmpDir);
    await taskRecorder.initialize();

    triggerSpy = vi.fn().mockResolvedValue(undefined);
    const mockApi = { triggerAgent: triggerSpy };
    plannerTrigger = new PlannerTrigger(mockApi);

    receiver = new AnomalyReceiver(taskRecorder, plannerTrigger);
  });

  function makeEvent(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
    return {
      type: 'spike',
      metricName: 'ttft',
      currentValue: 500,
      previousValue: 150,
      severity: 'high',
      deploymentName: 'llama-70b-prod',
      reasoning: 'TTFT spiked 233%',
      ...overrides,
    };
  }

  it('should accept a valid event and create a planning task', async () => {
    const events = [makeEvent()];
    const validated = await receiver.receive(events);

    expect(validated).toHaveLength(1);
    expect(validated[0].taskId).toBeDefined();
    expect(validated[0].eventId).toBeDefined();

    const task = taskRecorder.getTask(validated[0].taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('planning');
    expect(task!.llmDeploymentName).toBe('llama-70b-prod');
  });

  it('should trigger the Planner for each validated event', async () => {
    const events = [makeEvent()];
    await receiver.receive(events);

    // Allow async trigger to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(triggerSpy).toHaveBeenCalledTimes(1);
    expect(triggerSpy).toHaveBeenCalledWith(
      'pimclaw-planner',
      expect.objectContaining({
        mode: 'run',
        cleanup: 'delete',
        workspaceDir: undefined,
      }),
    );
  });

  it('should reject empty events array', async () => {
    await expect(receiver.receive([])).rejects.toThrow(/non-empty/);
  });

  it('should reject too many events', async () => {
    const events = Array.from({ length: 25 }, () => makeEvent({
      deploymentName: `deploy-${uuidv4()}`,
    }));
    await expect(receiver.receive(events)).rejects.toThrow(/Too many events/);
  });

  it('should skip events with invalid type', async () => {
    const events = [makeEvent({ type: 'invalid' as any })];
    const validated = await receiver.receive(events);
    expect(validated).toHaveLength(0);
  });

  it('should skip events with invalid severity', async () => {
    const events = [makeEvent({ severity: 'critical' as any })];
    const validated = await receiver.receive(events);
    expect(validated).toHaveLength(0);
  });

  it('should skip events with invalid metric name', async () => {
    const events = [makeEvent({ metricName: 'unknown_metric' })];
    const validated = await receiver.receive(events);
    expect(validated).toHaveLength(0);
  });

  it('should skip events with negative currentValue', async () => {
    const events = [makeEvent({ currentValue: -1 })];
    const validated = await receiver.receive(events);
    expect(validated).toHaveLength(0);
  });

  it('should skip events with NaN currentValue', async () => {
    const events = [makeEvent({ currentValue: NaN })];
    const validated = await receiver.receive(events);
    expect(validated).toHaveLength(0);
  });

  it('should skip events with missing deploymentName', async () => {
    const events = [makeEvent({ deploymentName: '' })];
    const validated = await receiver.receive(events);
    expect(validated).toHaveLength(0);
  });

  it('should deduplicate events for the same metric+deployment', async () => {
    const event = makeEvent();
    const first = await receiver.receive([event]);
    expect(first).toHaveLength(1);

    const second = await receiver.receive([event]);
    expect(second).toHaveLength(0); // deduplicated
  });

  it('should allow same metric for different deployments', async () => {
    const event1 = makeEvent({ deploymentName: 'deploy-a' });
    const event2 = makeEvent({ deploymentName: 'deploy-b' });

    const result = await receiver.receive([event1, event2]);
    expect(result).toHaveLength(2);
  });

  it('should accept multiple valid events in one submission', async () => {
    const events = [
      makeEvent({ metricName: 'ttft', deploymentName: 'deploy-1' }),
      makeEvent({ metricName: 'qps', deploymentName: 'deploy-1', type: 'drop' }),
      makeEvent({ metricName: 'ttft', deploymentName: 'deploy-2' }),
    ];

    const validated = await receiver.receive(events);
    expect(validated).toHaveLength(3);

    // Events are grouped by deployment: 2 events for deploy-1, 1 for deploy-2
    // → 2 planning tasks, not 3
    const counts = taskRecorder.getTaskCounts();
    expect(counts.planning).toBe(2);

    // All deploy-1 events share one taskId; deploy-2 has its own
    const taskIdDeploy1 = validated.find((e) => e.deploymentName === 'deploy-1')!.taskId;
    const taskIdDeploy2 = validated.find((e) => e.deploymentName === 'deploy-2')!.taskId;
    expect(taskIdDeploy1).toBeDefined();
    expect(taskIdDeploy2).toBeDefined();
    expect(taskIdDeploy1).not.toBe(taskIdDeploy2);

    // Both deploy-1 events have the same taskId
    const deploy1Events = validated.filter((e) => e.deploymentName === 'deploy-1');
    expect(deploy1Events).toHaveLength(2);
    expect(deploy1Events[0].taskId).toBe(deploy1Events[1].taskId);

    // Task data contains all events for each deployment
    const taskDeploy1 = taskRecorder.getTask(taskIdDeploy1)!;
    expect((taskDeploy1.taskData as any).events).toHaveLength(2);

    const taskDeploy2 = taskRecorder.getTask(taskIdDeploy2)!;
    expect((taskDeploy2.taskData as any).events).toHaveLength(1);
  });

  it('should set task priority based on severity', async () => {
    const highEvent = makeEvent({ severity: 'high', deploymentName: 'd1' });
    const medEvent = makeEvent({ severity: 'medium', deploymentName: 'd2' });
    const lowEvent = makeEvent({ severity: 'low', deploymentName: 'd3' });

    const results = await receiver.receive([highEvent, medEvent, lowEvent]);

    const highTask = taskRecorder.getTask(results[0].taskId)!;
    const medTask = taskRecorder.getTask(results[1].taskId)!;
    const lowTask = taskRecorder.getTask(results[2].taskId)!;

    expect(highTask.priority).toBe('high');
    expect(medTask.priority).toBe('medium');
    expect(lowTask.priority).toBe('medium');
  });
});
