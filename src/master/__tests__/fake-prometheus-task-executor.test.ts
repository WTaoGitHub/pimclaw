import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrometheusTaskExecutor } from '../fake-prometheus-task-executor.js';
import type { Task } from '../../types/index.js';

function makeTask(taskType: string): Task {
  return {
    taskId: 'task-1',
    status: 'running',
    createdAt: new Date(),
    statusModifiedAt: new Date(),
    priority: 'medium',
    llmDeploymentName: 'minimax-m25-tp8ep',
    taskType,
    taskData: {},
    retryCount: 0,
    maxRetries: 3,
  };
}

describe('FakePrometheusTaskExecutor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['restart', 'restart'],
    ['reconfigure', 'reconfigure'],
    ['scale-up', 'scale-out'],
    ['scale-down', 'scale-in'],
  ])('maps %s to fake remediation action %s', async (taskType, expectedAction) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, accepted_action: expectedAction }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const executor = new FakePrometheusTaskExecutor({
      baseUrl: 'http://fake-prometheus:9090/',
    });

    const result = await executor.execute(makeTask(taskType));

    expect(result.success).toBe(true);
    expect(result.serviceId).toBe('minimax-m25-tp8ep');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://fake-prometheus:9090/_fake/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: expectedAction,
          taskType,
          deploymentName: 'minimax-m25-tp8ep',
        }),
      }),
    );
  });

  it('rejects unsupported task types before calling the fake server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const executor = new FakePrometheusTaskExecutor({
      baseUrl: 'http://fake-prometheus:9090',
    });

    await expect(executor.execute(makeTask('delete'))).rejects.toThrow(
      'Unsupported fake remediation task type: delete',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
