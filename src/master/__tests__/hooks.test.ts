/**
 * Hook governance tests — non-fatal AnomalyReceiver hooks + tool hook pipeline
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnomalyReceiver } from '../anomaly-receiver.js';
import type { AnomalyEvent, HookResult } from '../anomaly-receiver.js';
import { TaskStatusRecorder } from '../task-status-recorder.js';
import { PlannerTrigger } from '../planner-trigger.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('AnomalyReceiver hooks governance', () => {
  let taskRecorder: TaskStatusRecorder;
  let plannerTrigger: PlannerTrigger;
  let triggerSpy: ReturnType<typeof vi.fn>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-hooks-'));
    taskRecorder = new TaskStatusRecorder(tmpDir);
    await taskRecorder.initialize();

    triggerSpy = vi.fn().mockImplementation(async () => {
      await new Promise(() => {});
    });
    const mockApi = { triggerAgent: triggerSpy };
    plannerTrigger = new PlannerTrigger(mockApi, taskRecorder);
  });

  function makeEvent(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
    return {
      type: 'spike',
      metricName: 'ttft',
      currentValue: 500,
      previousValue: 150,
      severity: 'high',
      deploymentName: `deploy-${uuidv4()}`,
      reasoning: 'TTFT spiked',
      ...overrides,
    };
  }

  it('should not break when onPlanningTaskCreated hook throws', async () => {
    const hookCalls: string[] = [];

    const receiver = new AnomalyReceiver(taskRecorder, plannerTrigger, undefined, {
      onPlanningTaskCreated: async () => {
        hookCalls.push('called');
        throw new Error('hook explosion');
      },
    });

    const events = [makeEvent()];
    const validated = await receiver.receive(events);

    // Event should still be accepted despite hook failure
    expect(validated).toHaveLength(1);
    expect(hookCalls).toEqual(['called']);

    // Task should still exist
    const task = taskRecorder.getTask(validated[0].taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('planning');
  });

  it('should not break when onPlannerTriggerFailed hook throws', async () => {
    triggerSpy.mockRejectedValueOnce(new Error('planner down'));

    const receiver = new AnomalyReceiver(taskRecorder, plannerTrigger, undefined, {
      onPlannerTriggerFailed: async () => {
        throw new Error('fallback hook also fails');
      },
    });

    const events = [makeEvent()];
    const validated = await receiver.receive(events);

    // Event should still be accepted
    expect(validated).toHaveLength(1);

    // Wait for async error handling
    await new Promise((r) => setTimeout(r, 50));
  });

  it('should skip planner trigger when hook returns preventContinuation', async () => {
    const receiver = new AnomalyReceiver(taskRecorder, plannerTrigger, undefined, {
      onPlanningTaskCreated: async (): Promise<HookResult> => {
        return { preventContinuation: true };
      },
    });

    const events = [makeEvent()];
    const validated = await receiver.receive(events);

    expect(validated).toHaveLength(1);

    // Wait and verify planner was NOT triggered
    await new Promise((r) => setTimeout(r, 50));
    expect(triggerSpy).not.toHaveBeenCalled();
  });

  it('should still trigger planner when hook returns without preventContinuation', async () => {
    const receiver = new AnomalyReceiver(taskRecorder, plannerTrigger, undefined, {
      onPlanningTaskCreated: async (): Promise<HookResult> => {
        return {};
      },
    });

    const events = [makeEvent()];
    await receiver.receive(events);

    await new Promise((r) => setTimeout(r, 50));
    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });

  it('should record hookDurationMs on validated event', async () => {
    const receiver = new AnomalyReceiver(taskRecorder, plannerTrigger, undefined, {
      onPlanningTaskCreated: async () => {
        // Simulate some hook work
        await new Promise((r) => setTimeout(r, 5));
      },
    });

    const events = [makeEvent()];
    const validated = await receiver.receive(events);

    expect(validated[0].hookDurationMs).toBeDefined();
    expect(validated[0].hookDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('should record hookDurationMs even when hook throws', async () => {
    const receiver = new AnomalyReceiver(taskRecorder, plannerTrigger, undefined, {
      onPlanningTaskCreated: async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('hook fail');
      },
    });

    const events = [makeEvent()];
    const validated = await receiver.receive(events);

    // hookDurationMs should still be set despite hook failure
    expect(validated[0].hookDurationMs).toBeDefined();
    expect(validated[0].hookDurationMs).toBeGreaterThanOrEqual(0);
  });
});
