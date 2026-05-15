/**
 * PimClaw v2 Full Pipeline E2E Test
 *
 * Covers the complete anomaly-to-resolution workflow:
 *
 *   1. Prometheus metrics collection (pimclaw_query_metrics with rangeMinutes)
 *   2. Head Agent detects anomaly → pimclaw_submit_anomalies
 *   3. AnomalyReceiver validates, creates planning task, triggers Planner
 *   4. Planner queries historical perf (pimclaw_query_perfllm)
 *   5. Planner simulates candidate config (pimclaw_sim_*)
 *   6. Planner submits plan → pimclaw_plan_task (task: planning → ready)
 *   7. Scheduler picks up ready task, spawns Worker
 *   8. Worker executes via TaskExecutor → Engine MCP (scale-up sequence)
 *   9. Task transitions: planning → ready → scheduling → scheduled → running → done
 *  10. Task result recorded with before/after state
 *
 * All external services (Prometheus, Engine MCP, Perf MCP, Sim MCP, OpenClaw Agent API)
 * are mocked. All internal components run in-process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { ComponentRegistry } from '../master/component-registry.js';
import { TaskStatusRecorder } from '../master/task-status-recorder.js';
import { SchedulerAgent } from '../master/scheduler-agent.js';
import { PlannerTrigger } from '../master/planner-trigger.js';
import { PlannerMemoryStore, buildPlannerMemoryEpisodeFromTask } from '../master/planner-memory-store.js';
import { AnomalyReceiver } from '../master/anomaly-receiver.js';
import type { AnomalyEvent } from '../master/anomaly-receiver.js';
import { TaskExecutor } from '../master/task-executor.js';
import type { Task } from '../types/index.js';
import type { EngineMcpClient } from '../master/engine-mcp-client.js';
import {
  PrometheusClient,
  sglangPromQLMap,
  injectLabels,
} from '../master/prometheus-client.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Build fake Prometheus range-query result: array of [timestamp, value] pairs */
function fakeRangeResult(baseValue: number, count = 20, jitter = 0.05) {
  const now = Math.floor(Date.now() / 1000);
  const step = 15;
  const values: [number, string][] = [];
  for (let i = 0; i < count; i++) {
    const t = now - (count - 1 - i) * step;
    const v = baseValue * (1 + (Math.random() - 0.5) * 2 * jitter);
    values.push([t, v.toFixed(6)]);
  }
  return [{ metric: { __name__: 'test' }, values }];
}

/** Create a mock EngineMcpClient that simulates a successful scale-up sequence */
function createMockEngineClient() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const client = {
    isConnected: true,

    callTool: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      calls.push({ tool: toolName, args });

      switch (toolName) {
        case 'model_deploy_list_services':
          return {
            items: [
              { serviceId: '200', serviceName: 'minimax-m2-1-prod', status: 1 },
              { serviceId: '201', serviceName: 'llama-70b-staging', status: 1 },
            ],
          };

        case 'model_deploy_get_service':
          return {
            serviceId: args.serviceId,
            serviceName: 'minimax-m2-1-prod',
            replicas: args.serviceId === '200' ? 2 : 1,
            status: 1,
            statusName: 'running',
            gpu: 8,
            dtype: 'bf16',
          };

        case 'model_deploy_update_service':
          return { ok: true, serviceId: args.serviceId };

        case 'model_deploy_restart_service':
          return { ok: true, ids: args.ids };

        default:
          throw new Error(`Unexpected MCP tool call: ${toolName}`);
      }
    }),

    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ connected: true }),
  };

  return { client: client as unknown as EngineMcpClient, calls };
}

// ─── Full Pipeline E2E ─────────────────────────────────────────────────────

describe('PimClaw v2 full pipeline E2E', () => {
  let tmpDir: string;
  let registry: ComponentRegistry;
  let recorder: TaskStatusRecorder;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-e2e-'));
    registry = new ComponentRegistry();
    recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('anomaly detected → planned → scheduled → executed → done', async () => {
    const plannerMemoryStore = new PlannerMemoryStore(tmpDir);
    await plannerMemoryStore.load();

    // ================================================================
    // PHASE 1: Prometheus Metrics Collection (pimclaw_query_metrics)
    // ================================================================
    // Simulate what the Head Agent receives when calling
    // pimclaw_query_metrics with rangeMinutes: 5

    const metricsSnapshot: Record<string, unknown> = {
      ttft: fakeRangeResult(0.450),         // 450ms — elevated TTFT
      tpot: fakeRangeResult(0.025),         // 25ms per token — normal
      qps: fakeRangeResult(12),             // 12 req/s — normal
      throughput: fakeRangeResult(480),      // 480 tok/s — normal
      gpu_utilization: fakeRangeResult(0.92),// 92% — near capacity
      error_rate: fakeRangeResult(0.8),      // 0.8% — normal
    };

    // The Head Agent would analyze this window and detect:
    // - TTFT is trending high (previous window average was ~0.15s, now ~0.45s → 200%+ increase)
    // - GPU utilization near saturation (92%)
    // - QPS stable → not a load spike, likely model degradation or resource starvation

    // Verify range data shape matches what agent expects
    const ttftData = metricsSnapshot.ttft as Array<{ values: [number, string][] }>;
    expect(ttftData).toHaveLength(1);
    expect(ttftData[0].values).toHaveLength(20);
    expect(ttftData[0].values[0]).toHaveLength(2); // [timestamp, value]

    // ================================================================
    // PHASE 2: Head Agent submits anomaly (pimclaw_submit_anomalies)
    // ================================================================

    // Track Planner triggers
    const plannerTriggerCalls: Array<{
      agentId: string;
      taskId: string;
      events: AnomalyEvent[];
    }> = [];

    const mockPlannerApi = {
      triggerAgent: vi.fn(async (_agentId: string, options: any) => {
        const payload = JSON.parse(options.attachments?.[0]?.content ?? '{}');
        plannerTriggerCalls.push({
          agentId: _agentId,
          taskId: payload.taskId,
          events: payload.events ?? [],
        });
        await new Promise(() => {});
      }),
    };

    const plannerTrigger = new PlannerTrigger(mockPlannerApi as any, recorder, {
      agentId: 'pimclaw-planner',
      timeoutSeconds: 600,
      workspaceDir: '/tmp/pimclaw-planner-workspace',
    }, undefined, plannerMemoryStore);
    const anomalyReceiver = new AnomalyReceiver(recorder, plannerTrigger);

    // Head Agent's anomaly events based on metrics analysis
    const anomalyEvents: AnomalyEvent[] = [
      {
        type: 'spike',
        metricName: 'ttft',
        currentValue: 0.45,
        previousValue: 0.15,
        severity: 'high',
        deploymentName: 'minimax-m2-1-prod',
        reasoning:
          'TTFT window average 0.45s vs previous window 0.15s (200% increase). ' +
          'QPS stable at 12 req/s → not load-driven. GPU utilization 92% suggests ' +
          'resource saturation. Correlates with high GPU + rising TTFT = KV cache pressure.',
      },
    ];

    const validatedEvents = await anomalyReceiver.receive(anomalyEvents);

    // Verify anomaly accepted and task created
    expect(validatedEvents).toHaveLength(1);
    const taskId = validatedEvents[0].taskId;
    expect(taskId).toBeTruthy();

    // Verify planning task created in recorder
    const planningTask = recorder.getTask(taskId);
    expect(planningTask).toBeDefined();
    expect(planningTask!.status).toBe('planning');
    expect(planningTask!.priority).toBe('high');
    expect(planningTask!.llmDeploymentName).toBe('minimax-m2-1-prod');

    // Verify Planner agent was triggered
    expect(plannerTriggerCalls).toHaveLength(1);
    expect(plannerTriggerCalls[0].agentId).toBe('pimclaw-planner');
    expect(plannerTriggerCalls[0].taskId).toBe(taskId);

    // Task counts at this point
    let counts = recorder.getTaskCounts();
    expect(counts.planning).toBe(1);

    // ================================================================
    // PHASE 3: Planner queries perf data (pimclaw_query_perfllm)
    // ================================================================
    // Simulated response from Perf MCP — historical configs for this model
    const perfEvidence = {
      rows: [
        {
          model_name: 'MiniMax-M2.1',
          engine_name: 'sglang',
          device_type: 'nvidia/h800',
          node_num: 1,
          device_per_node: 8,
          tensor_parallel_size: 8,
          data_parallel_size: 1,
          dtype: 'bf16',
          gpu_memory_utilization: 0.9,
          ttft: 0.12,
          tpot: 0.02,
          qps: 15,
          throughput: 600,
        },
        {
          model_name: 'MiniMax-M2.1',
          engine_name: 'sglang',
          device_type: 'nvidia/h800',
          node_num: 2,
          device_per_node: 8,
          tensor_parallel_size: 8,
          data_parallel_size: 2,
          dtype: 'bf16',
          gpu_memory_utilization: 0.9,
          ttft: 0.08,
          tpot: 0.015,
          qps: 30,
          throughput: 1200,
        },
      ],
    };

    // ================================================================
    // PHASE 4: Planner simulates candidate (pimclaw_sim_benchmark)
    // ================================================================
    // Simulated response from Sim MCP — predicted performance with scale-up
    const simulationResults = {
      mean_ttft_ms: 95,
      mean_tpot_ms: 18,
      output_throughput: 1100,
      request_throughput: 28,
      mean_e2e_latency_ms: 450,
    };

    // ================================================================
    // PHASE 5: Planner submits plan (pimclaw_plan_task → task ready)
    // ================================================================
    // The Planner Agent would call pimclaw_plan_task which updates the task
    // Simulate what the plugin's pimclaw_plan_task tool handler does:

    const task = recorder.getTask(taskId)!;
    task.taskType = 'scale-up';
    task.config = {
      replicas: 3,
      replicaDelta: 1,
      dtype: 'bf16',
      tensorParallelism: 8,
    };
    task.reasoning =
      'Historical data shows 2-node config handles 30 QPS with TTFT 0.08s. ' +
      'Current 1-node at 92% GPU utilization is saturated. ' +
      'Scale up by 1 replica to distribute KV cache pressure.';
    task.perfEvidence = JSON.stringify(perfEvidence);
    task.simulationResults = JSON.stringify(simulationResults);

    await recorder.updateTaskStatus(taskId, 'ready');

    // Verify transition
    expect(recorder.getTask(taskId)!.status).toBe('ready');
    expect(recorder.getTask(taskId)!.taskType).toBe('scale-up');
    expect(recorder.getTask(taskId)!.config).toEqual({
      replicas: 3,
      replicaDelta: 1,
      dtype: 'bf16',
      tensorParallelism: 8,
    });

    counts = recorder.getTaskCounts();
    expect(counts.planning).toBe(0);
    expect(counts.ready).toBe(1);

    // ================================================================
    // PHASE 6: Scheduler picks up task, creates Worker
    // ================================================================
    const { client: mockEngineClient, calls: engineCalls } = createMockEngineClient();
    const taskExecutor = new TaskExecutor(mockEngineClient);
    const scheduler = new SchedulerAgent(registry, recorder, 2, taskExecutor, plannerMemoryStore);
    await scheduler.initialize();

    // Run a single scheduling cycle (don't start the polling loop)
    await (scheduler as any).schedulingCycle();

    // Give the Worker time to run (it runs asynchronously in background)
    // Worker: scheduled → running → execute → done
    await new Promise(resolve => setTimeout(resolve, 200));

    // ================================================================
    // PHASE 7: Verify task execution via Engine MCP
    // ================================================================

    // TaskExecutor should have called Engine MCP tools in sequence:
    // 1. model_deploy_list_services (resolve deployment → serviceId)
    // 2. model_deploy_get_service (get current config — replicas, etc.)
    // 3. model_deploy_update_service (set new replicas)
    // 4. model_deploy_restart_service (restart)
    // 5. model_deploy_get_service (poll until ready)
    expect(engineCalls.length).toBeGreaterThanOrEqual(4);

    const toolSequence = engineCalls.map(c => c.tool);
    expect(toolSequence).toContain('model_deploy_list_services');
    expect(toolSequence).toContain('model_deploy_get_service');
    expect(toolSequence).toContain('model_deploy_update_service');
    expect(toolSequence).toContain('model_deploy_restart_service');

    // Verify scale-up: replicas went from 2 → 3 (delta = 1)
    const updateCall = engineCalls.find(c => c.tool === 'model_deploy_update_service');
    expect(updateCall).toBeDefined();
    expect(updateCall!.args.serviceId).toBe('200');
    expect(updateCall!.args.replicas).toBe(3); // 2 existing + 1 delta

    // ================================================================
    // PHASE 8: Verify final task state
    // ================================================================
    const finalTask = recorder.getTask(taskId)!;
    expect(finalTask.status).toBe('done');
    expect(finalTask.completedAt).toBeDefined();

    // Verify result contains before/after state
    expect(finalTask.result).toBeDefined();
    const result = finalTask.result as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.taskType).toBe('scale-up');
    expect(result.serviceId).toBe('200');

    // Verify full status transition path was recorded
    // planning → ready → scheduling → scheduled → running → done
    // (We can't see intermediate transitions, but final state is 'done')
    expect(finalTask.error).toBeUndefined();
    expect(finalTask.feedback?.statusSummary).toBe('completed-successfully');

    // Verify task counts reflect completion
    const finalCounts = recorder.getTaskCounts();
    expect(finalCounts.done).toBe(1);
    expect(finalCounts.planning).toBe(0);
    expect(finalCounts.ready).toBe(0);
    expect(finalCounts.running).toBe(0);

    // ================================================================
    // PHASE 9: Verify component registry health
    // ================================================================
    const health = registry.getHealthReport();
    expect(health).toBeDefined();

    // Scheduler should be registered
    const schedulerStatus = registry.getAgentStatus('scheduler-1');
    expect(schedulerStatus).toBeDefined();

    const recentEpisodes = plannerMemoryStore.getRecentEpisodes('minimax-m2-1-prod', 1);
    expect(recentEpisodes).toHaveLength(1);
    expect(recentEpisodes[0]?.taskId).toBe(taskId);
    expect(recentEpisodes[0]?.taskStatus).toBe('done');

    // Clean up
    await scheduler.shutdown();
  }, 10_000);

  it('attaches prior task feedback memory while the new plan still carries perf and simulation evidence', async () => {
    const plannerMemoryStore = new PlannerMemoryStore(tmpDir);
    await plannerMemoryStore.load();

    const priorTaskId = uuidv4();
    const priorTask: Task = {
      taskId: priorTaskId,
      status: 'done' as const,
      createdAt: new Date('2026-04-22T00:00:00.000Z'),
      statusModifiedAt: new Date('2026-04-22T00:10:00.000Z'),
      priority: 'high' as const,
      llmDeploymentName: 'minimax-m2-1-prod',
      taskType: 'scale-up',
      taskData: {
        events: [
          {
            eventId: 'prior-event-1',
            metricName: 'ttft',
            severity: 'high',
          },
        ],
      },
      config: { replicaDelta: 1, replicas: 3 },
      reasoning: 'Previous scale-up used as a conservative mitigation.',
      perfEvidence: 'Historical perf showed TTFT improvement with one more replica.',
      simulationResults: 'Simulation predicted TTFT reduction under the same load band.',
      retryCount: 0,
      maxRetries: 3,
      completedAt: new Date('2026-04-22T00:10:00.000Z'),
      result: { success: true, after: { replicas: 3 } },
      feedback: {
        version: 1,
        statusSummary: 'completed-successfully' as const,
        outcome: 'helped' as const,
        source: 'system' as const,
        generatedAt: new Date('2026-04-22T00:11:00.000Z'),
        summary: 'Previous scale-up improved the deployment outcome.',
      },
    };

    await recorder.createTask(priorTask);
    plannerMemoryStore.upsertEpisode(buildPlannerMemoryEpisodeFromTask(priorTask));
    await plannerMemoryStore.flush();

    let capturedTaskText = '';
    let capturedAttachments: Array<{ type: string; content: string }> = [];
    const mockPlannerApi = {
      triggerAgent: vi.fn(async (_agentId: string, options: any) => {
        capturedTaskText = options.task;
        capturedAttachments = options.attachments ?? [];

        const payload = JSON.parse(capturedAttachments[0]?.content ?? '{}');
        const task = recorder.getTask(payload.taskId)!;
        task.taskType = 'scale-up';
        task.config = {
          replicas: 4,
          replicaDelta: 1,
          dtype: 'bf16',
          tensorParallelism: 8,
        };
        task.reasoning =
          'Recent planner memory shows a prior scale-up helped this deployment. ' +
          'Historical perf and fresh simulation evidence still support scaling by one replica.';
        task.perfEvidence = JSON.stringify({
          rows: [
            {
              model_name: 'MiniMax-M2.1',
              engine_name: 'sglang',
              ttft: 0.11,
              qps: 16,
            },
          ],
        });
        task.simulationResults = JSON.stringify({
          mean_ttft_ms: 90,
          mean_tpot_ms: 18,
          output_throughput: 1200,
          request_throughput: 30,
        });
        await recorder.updateTaskStatus(payload.taskId, 'ready');
      }),
    };

    const plannerTrigger = new PlannerTrigger(mockPlannerApi as any, recorder, {
      agentId: 'pimclaw-planner',
      timeoutSeconds: 2,
      workspaceDir: path.join(tmpDir, 'planner-workspace'),
    }, registry, plannerMemoryStore);
    const anomalyReceiver = new AnomalyReceiver(recorder, plannerTrigger);

    const validatedEvents = await anomalyReceiver.receive([
      {
        type: 'spike',
        metricName: 'ttft',
        currentValue: 0.52,
        previousValue: 0.18,
        severity: 'high',
        deploymentName: 'minimax-m2-1-prod',
        reasoning: 'TTFT is spiking again for the same deployment.',
      },
    ]);

    expect(validatedEvents).toHaveLength(1);

    await vi.waitFor(() => {
      expect(mockPlannerApi.triggerAgent).toHaveBeenCalledTimes(1);
    });

    expect(capturedTaskText).toContain('Recent planner memory is attached separately');
    expect(capturedAttachments).toHaveLength(2);

    const memoryContext = JSON.parse(capturedAttachments[1]!.content);
    expect(memoryContext.deploymentName).toBe('minimax-m2-1-prod');
    expect(memoryContext.recentEpisodes).toHaveLength(1);
    expect(memoryContext.recentEpisodes[0].taskId).toBe(priorTaskId);
    expect(memoryContext.recentEpisodes[0].feedback.outcome).toBe('helped');

    const newTaskId = validatedEvents[0]!.taskId;
    const plannedTask = recorder.getTask(newTaskId)!;
    expect(plannedTask.status).toBe('ready');
    expect(plannedTask.reasoning).toContain('Historical perf');
    expect(plannedTask.perfEvidence).toContain('MiniMax-M2.1');
    expect(plannedTask.simulationResults).toContain('mean_ttft_ms');
  });
});
