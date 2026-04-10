/**
 * TaskExecutor Tests — mock EngineMcpClient to test task type dispatching
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskExecutor } from '../../master/task-executor.js';
import type { EngineMcpClient } from '../../master/engine-mcp-client.js';
import type { Task } from '../../types/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task-1',
    status: 'running',
    createdAt: new Date(),
    statusModifiedAt: new Date(),
    priority: 'medium',
    llmDeploymentName: 'my-service',
    taskType: 'scale-up',
    taskData: {},
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeServiceResponse(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: '100',
    serviceName: 'my-service',
    status: 1,
    statusName: 'running',
    replicas: 2,
    cpu: 4,
    memory: 16,
    gpuCount: 8,
    ...overrides,
  };
}

describe('TaskExecutor', () => {
  let executor: TaskExecutor;
  let mockClient: {
    callTool: ReturnType<typeof vi.fn>;
    isConnected: boolean;
  };

  beforeEach(() => {
    mockClient = {
      callTool: vi.fn(),
      isConnected: true,
    };
    executor = new TaskExecutor(mockClient as unknown as EngineMcpClient);
  });

  // ── Service Resolution ────────────────────────────────────────────────────

  describe('resolveServiceId', () => {
    it('resolves by exact serviceName match', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        items: [
          { serviceId: '100', serviceName: 'my-service' },
          { serviceId: '200', serviceName: 'other-service' },
        ],
      });

      const id = await executor.resolveServiceId('my-service');
      expect(id).toBe('100');
    });

    it('returns cached result on second call', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        items: [{ serviceId: '100', serviceName: 'my-service' }],
      });

      await executor.resolveServiceId('my-service');
      const id = await executor.resolveServiceId('my-service');
      expect(id).toBe('100');
      // model_deploy_list_services called only once
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);
    });

    it('throws when service not found', async () => {
      mockClient.callTool.mockResolvedValueOnce({ items: [] });
      await expect(executor.resolveServiceId('nonexistent')).rejects.toThrow('Service not found');
    });
  });

  // ── Scale Up ──────────────────────────────────────────────────────────────

  describe('scale-up', () => {
    it('increments replicas and restarts', async () => {
      // list_services → resolve
      mockClient.callTool.mockResolvedValueOnce({
        items: [{ serviceId: '100', serviceName: 'my-service' }],
      });
      // get_service → current config
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse({ replicas: 2 }));
      // update_service
      mockClient.callTool.mockResolvedValueOnce({ ok: true });
      // restart_service
      mockClient.callTool.mockResolvedValueOnce({ ok: true });
      // get_service → poll for ready (already running)
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse({ replicas: 3, status: 1 }));

      const task = makeTask({ taskType: 'scale-up', config: { replicaDelta: 1 } });
      const result = await executor.execute(task);

      expect(result.success).toBe(true);
      expect(result.taskType).toBe('scale-up');
      expect(result.before).toEqual({ replicas: 2 });
      expect(result.after?.replicas).toBe(3);

      // Verify update_service was called with replicas: 3
      const updateCall = mockClient.callTool.mock.calls.find(
        (c: any) => c[0] === 'model_deploy_update_service',
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toMatchObject({ replicas: 3 });
    });
  });

  // ── Scale Down ────────────────────────────────────────────────────────────

  describe('scale-down', () => {
    it('decrements replicas (min 1)', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        items: [{ serviceId: '100', serviceName: 'my-service' }],
      });
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse({ replicas: 3 }));
      mockClient.callTool.mockResolvedValueOnce({ ok: true }); // update
      mockClient.callTool.mockResolvedValueOnce({ ok: true }); // restart
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse({ replicas: 2, status: 1 }));

      const task = makeTask({ taskType: 'scale-down', config: { replicaDelta: 1 } });
      const result = await executor.execute(task);

      expect(result.success).toBe(true);
      expect(result.before).toEqual({ replicas: 3 });
      expect(result.after?.replicas).toBe(2);
    });

    it('does not go below 1 replica', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        items: [{ serviceId: '100', serviceName: 'my-service' }],
      });
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse({ replicas: 1 }));

      const task = makeTask({ taskType: 'scale-down', config: { replicaDelta: 1 } });
      const result = await executor.execute(task);

      expect(result.success).toBe(true);
      expect(result.before).toEqual({ replicas: 1 });
      expect(result.after?.replicas).toBe(1);
      // Should NOT call update or restart
      expect(mockClient.callTool).toHaveBeenCalledTimes(2); // list + get only
    });
  });

  // ── Restart ───────────────────────────────────────────────────────────────

  describe('restart', () => {
    it('calls restart_service and polls for ready', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        items: [{ serviceId: '100', serviceName: 'my-service' }],
      });
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse()); // get before
      mockClient.callTool.mockResolvedValueOnce({ ok: true }); // restart
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse({ status: 1 })); // poll

      const task = makeTask({ taskType: 'restart' });
      const result = await executor.execute(task);

      expect(result.success).toBe(true);
      expect(result.taskType).toBe('restart');

      const restartCall = mockClient.callTool.mock.calls.find(
        (c: any) => c[0] === 'model_deploy_restart_service',
      );
      expect(restartCall).toBeDefined();
      expect(restartCall![1]).toMatchObject({ ids: '100' });
    });
  });

  // ── Reconfigure ───────────────────────────────────────────────────────────

  describe('reconfigure', () => {
    it('maps config fields to update_service params', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        items: [{ serviceId: '100', serviceName: 'my-service' }],
      });
      mockClient.callTool.mockResolvedValueOnce(makeServiceResponse()); // get before
      mockClient.callTool.mockResolvedValueOnce({ ok: true }); // update
      mockClient.callTool.mockResolvedValueOnce({ ok: true }); // restart
      mockClient.callTool.mockResolvedValueOnce(
        makeServiceResponse({ gpuCount: 16, status: 1 }),
      ); // poll

      const task = makeTask({
        taskType: 'reconfigure',
        config: { gpuCount: 16, memory: 32 },
      });
      const result = await executor.execute(task);

      expect(result.success).toBe(true);

      const updateCall = mockClient.callTool.mock.calls.find(
        (c: any) => c[0] === 'model_deploy_update_service',
      );
      expect(updateCall![1]).toMatchObject({
        serviceId: '100',
        gpuCount: 16,
        memory: 32,
      });
    });
  });

  // ── Unknown task type ──────────────────────────────────────────────────────

  it('throws on unknown task type', async () => {
    mockClient.callTool.mockResolvedValueOnce({
      items: [{ serviceId: '100', serviceName: 'my-service' }],
    });

    const task = makeTask({ taskType: 'delete' });
    await expect(executor.execute(task)).rejects.toThrow('Unknown task type: delete');
  });
});
