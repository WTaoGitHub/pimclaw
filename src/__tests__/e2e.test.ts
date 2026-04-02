/**
 * End-to-end test for PimClaw orchestration system.
 *
 * Boots the full stack (AgentRegistry → TaskStatusRecorder → SchedulerAgent → HeadAgent)
 * **without** real MCP services.  The HeadAgent already generates mock metrics, so
 * real Grafana/Engine/Perf servers are not needed to exercise the complete lifecycle:
 *
 *   1. Agent boot & registration
 *   2. Task creation via the plugin tool
 *   3. Scheduler picks up the task
 *   4. Task completion / failure / retry / revoke
 *   5. Health & status queries
 *   6. Agent shutdown
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { AgentRegistry } from '../master/agent-registry.js';
import { TaskStatusRecorder } from '../master/task-status-recorder.js';
import { SchedulerAgent } from '../master/scheduler-agent.js';
import { HeadAgent } from '../master/head-agent.js';
import { Task } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a fresh Task object in "ready" state. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: uuidv4(),
    status: 'ready',
    createdAt: new Date(),
    statusModifiedAt: new Date(),
    priority: 'medium',
    llmDeploymentName: 'test-deployment',
    taskType: 'scale-up',
    taskData: {},
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

/**
 * Wait until `predicate` returns true, polling every `intervalMs`.
 * Throws if `timeoutMs` is exceeded.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── setup ────────────────────────────────────────────────────────────────────

let tmpDir: string;
let registry: AgentRegistry;
let taskRecorder: TaskStatusRecorder;
let scheduler: SchedulerAgent;
let schedulerPromise: Promise<void> | null = null;

beforeAll(async () => {
  // Unique temp directory for each test run
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-e2e-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('PimClaw E2E – full stack without MCP services', () => {
  // ────── 1. Component boot ────────────────────────────────────────────────

  describe('1 – Boot & agent registration', () => {
    beforeEach(async () => {
      // Fresh instances per test group
      registry = new AgentRegistry();
      taskRecorder = new TaskStatusRecorder(
        path.join(tmpDir, `tasks-${uuidv4()}`),
      );
      await taskRecorder.initialize();
    });

    it('should create AgentRegistry and TaskStatusRecorder', () => {
      expect(registry).toBeDefined();
      expect(taskRecorder).toBeDefined();
      expect(registry.getAllAgentsStatus()).toHaveLength(0);
      expect(taskRecorder.getAllTasks()).toHaveLength(0);
    });

    it('should register SchedulerAgent in the registry on initialize', async () => {
      scheduler = new SchedulerAgent(registry, taskRecorder);
      await scheduler.initialize();

      const agents = registry.getAllAgentsStatus();
      expect(agents).toHaveLength(1);

      const sched = agents.find((a) => a.agentType === 'scheduler');
      expect(sched).toBeDefined();
      expect(sched!.status).toBe('Listening');

      await scheduler.shutdown();
    });

    it('should deregister agent on shutdown', async () => {
      scheduler = new SchedulerAgent(registry, taskRecorder);
      await scheduler.initialize();
      expect(registry.getAllAgentsStatus()).toHaveLength(1);

      await scheduler.shutdown();
      expect(registry.getAllAgentsStatus()).toHaveLength(0);
    });
  });

  // ────── 2. Task lifecycle via TaskStatusRecorder ─────────────────────────

  describe('2 – Task lifecycle (TaskStatusRecorder)', () => {
    let recorder: TaskStatusRecorder;

    beforeEach(async () => {
      recorder = new TaskStatusRecorder(
        path.join(tmpDir, `tasks-lifecycle-${uuidv4()}`),
      );
      await recorder.initialize();
    });

    it('should create and retrieve a task', async () => {
      const task = makeTask();
      await recorder.createTask(task);

      const retrieved = recorder.getTask(task.taskId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.status).toBe('ready');
      expect(retrieved!.llmDeploymentName).toBe('test-deployment');
    });

    it('should update task status through the state machine', async () => {
      const task = makeTask();
      await recorder.createTask(task);

      await recorder.updateTaskStatus(task.taskId, 'scheduling');
      expect(recorder.getTask(task.taskId)!.status).toBe('scheduling');

      await recorder.updateTaskStatus(task.taskId, 'scheduled');
      expect(recorder.getTask(task.taskId)!.status).toBe('scheduled');

      await recorder.updateTaskStatus(task.taskId, 'running');
      expect(recorder.getTask(task.taskId)!.status).toBe('running');
    });

    it('should complete a task with result', async () => {
      const task = makeTask();
      await recorder.createTask(task);

      await recorder.updateTaskResult(
        task.taskId,
        { replicas: 4, message: 'scaled up' },
        null,
      );

      const t = recorder.getTask(task.taskId)!;
      expect(t.status).toBe('done');
      expect(t.result).toEqual({ replicas: 4, message: 'scaled up' });
      expect(t.completedAt).toBeDefined();
    });

    it('should fail a task with error', async () => {
      const task = makeTask();
      await recorder.createTask(task);

      await recorder.updateTaskResult(task.taskId, null, 'deployment timeout');

      const t = recorder.getTask(task.taskId)!;
      expect(t.status).toBe('failed');
      expect(t.error).toBe('deployment timeout');
    });

    it('should reset a failed task for retry', async () => {
      const task = makeTask();
      await recorder.createTask(task);
      await recorder.updateTaskResult(task.taskId, null, 'transient error');

      await recorder.resetTaskForRetry(task.taskId);

      const t = recorder.getTask(task.taskId)!;
      expect(t.status).toBe('ready');
      expect(t.retryCount).toBe(1);
      expect(t.error).toBeUndefined();
      expect(t.result).toBeUndefined();
    });

    it('should refuse to reset beyond maxRetries', async () => {
      const task = makeTask({ retryCount: 3, maxRetries: 3 });
      await recorder.createTask(task);
      await recorder.updateTaskResult(task.taskId, null, 'fatal');

      await expect(recorder.resetTaskForRetry(task.taskId)).rejects.toThrow(
        /exceeded max retries/,
      );
    });

    it('should return correct task counts by status', async () => {
      await recorder.createTask(makeTask());
      await recorder.createTask(makeTask());
      const failTask = makeTask();
      await recorder.createTask(failTask);
      await recorder.updateTaskResult(failTask.taskId, null, 'bang');

      const counts = recorder.getTaskCounts();
      expect(counts.ready).toBe(2);
      expect(counts.failed).toBe(1);
      expect(counts.done).toBe(0);
    });

    it('should filter tasks by status', async () => {
      const t1 = makeTask();
      const t2 = makeTask();
      await recorder.createTask(t1);
      await recorder.createTask(t2);
      await recorder.updateTaskResult(t2.taskId, { ok: true }, null);

      expect(recorder.getTasksByStatus('ready')).toHaveLength(1);
      expect(recorder.getTasksByStatus('done')).toHaveLength(1);
    });

    it('should persist tasks to disk and reload', async () => {
      const storagePath = path.join(tmpDir, `persist-${uuidv4()}`);

      const r1 = new TaskStatusRecorder(storagePath);
      await r1.initialize();
      const task = makeTask();
      await r1.createTask(task);

      // Create a new instance pointing at the same path
      const r2 = new TaskStatusRecorder(storagePath);
      await r2.initialize();
      const loaded = r2.getTask(task.taskId);
      expect(loaded).toBeDefined();
      expect(loaded!.taskId).toBe(task.taskId);
    });
  });

  // ────── 3. Scheduler picks up tasks ──────────────────────────────────────

  describe('3 – SchedulerAgent scheduling cycle', () => {
    let sched: SchedulerAgent;
    let reg: AgentRegistry;
    let rec: TaskStatusRecorder;

    beforeEach(async () => {
      reg = new AgentRegistry();
      rec = new TaskStatusRecorder(
        path.join(tmpDir, `sched-${uuidv4()}`),
      );
      await rec.initialize();
      sched = new SchedulerAgent(reg, rec, 5);
      await sched.initialize();
    });

    afterAll(async () => {
      // Defensive – if sched is still running
      try {
        await sched?.shutdown();
      } catch { /* ignore */ }
    });

    it('should pick up a ready task within one scheduling cycle', async () => {
      const task = makeTask();
      await rec.createTask(task);
      expect(rec.getTask(task.taskId)!.status).toBe('ready');

      // Run the scheduler loop briefly in the background
      const loopPromise = sched.run();

      // Wait for the scheduler to pick it up
      await waitFor(() => {
        const t = rec.getTask(task.taskId);
        return t?.status === 'scheduled' || t?.status === 'scheduling';
      });

      const t = rec.getTask(task.taskId);
      expect(['scheduling', 'scheduled']).toContain(t!.status);

      await sched.shutdown();
      // Allow loop to exit
      await loopPromise.catch(() => {});
    });

    it('should mark task completed via taskCompleted()', async () => {
      const task = makeTask();
      await rec.createTask(task);

      // Manually advance to running
      await rec.updateTaskStatus(task.taskId, 'running');

      await sched.taskCompleted(task.taskId, { replicas: 2 });

      const t = rec.getTask(task.taskId)!;
      expect(t.status).toBe('done');
      expect(t.result).toEqual({ replicas: 2 });

      await sched.shutdown();
    });

    it('should retry a failed task if retries remain', async () => {
      const task = makeTask({ retryCount: 0, maxRetries: 3 });
      await rec.createTask(task);
      await rec.updateTaskStatus(task.taskId, 'running');

      await sched.taskFailed(task.taskId, 'transient failure');

      const t = rec.getTask(task.taskId)!;
      // Should be reset to ready for retry
      expect(t.status).toBe('ready');
      expect(t.retryCount).toBe(1);

      await sched.shutdown();
    });

    it('should mark task failed permanently when retries exhausted', async () => {
      const task = makeTask({ retryCount: 3, maxRetries: 3 });
      await rec.createTask(task);
      await rec.updateTaskStatus(task.taskId, 'running');

      await sched.taskFailed(task.taskId, 'terminal failure');

      const t = rec.getTask(task.taskId)!;
      expect(t.status).toBe('failed');
      expect(t.error).toBe('terminal failure');

      await sched.shutdown();
    });
  });

  // ────── 4. AgentRegistry health report ───────────────────────────────────

  describe('4 – AgentRegistry health reporting', () => {
    it('should produce a health report with registered agents', async () => {
      const reg = new AgentRegistry();
      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `health-${uuidv4()}`),
      );
      await rec.initialize();

      const sched = new SchedulerAgent(reg, rec);
      await sched.initialize();

      const report = reg.getHealthReport();
      expect(report.totalAgents).toBe(1);
      expect(report.healthyAgents).toBe(1);
      expect(report.totalErrors).toBe(0);
      expect(report.issues).toHaveLength(0);
      expect(report.agents[0].agentType).toBe('scheduler');

      await sched.shutdown();
    });

    it('should list issues when errors are recorded', async () => {
      const reg = new AgentRegistry();
      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `health-issue-${uuidv4()}`),
      );
      await rec.initialize();

      const sched = new SchedulerAgent(reg, rec);
      await sched.initialize();

      // Record enough errors to trigger the issue threshold (>5)
      const agentId = reg.getAllAgentsStatus()[0].agentId;
      for (let i = 0; i < 6; i++) {
        reg.recordError(agentId, `error-${i}`);
      }

      const report = reg.getHealthReport();
      expect(report.totalErrors).toBe(6);
      expect(report.healthyAgents).toBe(0);
      expect(report.issues.length).toBeGreaterThanOrEqual(1);
      expect(report.issues.some((i) => i.severity === 'error')).toBe(true);

      await sched.shutdown();
    });
  });

  // ────── 5. OpenClaw plugin tools (unit-level) ────────────────────────────
  //
  // These exercise the same logic the plugin tools use:
  //  - pimclaw_route_task     → createTask
  //  - pimclaw_list_agents    → registry.getAllAgentsStatus
  //  - pimclaw_agent_status   → registry.getAgentStatus
  //  - pimclaw_health         → registry.getHealthReport
  //  - pimclaw_task_counts    → taskRecorder.getTaskCounts
  //  - pimclaw_list_tasks     → taskRecorder.getAllTasks / getTasksByStatus
  //  - pimclaw_retry_task     → taskRecorder.resetTaskForRetry
  //  - pimclaw_revoke_task    → taskRecorder.updateTaskStatus(…, 'expired')
  //
  // We test through real functions rather than importing the plugin entry
  // (which requires the OpenClaw runtime). This validates the core paths.
  // ────────────────────────────────────────────────────────────────────────

  describe('5 – Plugin tool flows', () => {
    let reg: AgentRegistry;
    let rec: TaskStatusRecorder;
    let sched: SchedulerAgent;

    beforeEach(async () => {
      reg = new AgentRegistry();
      rec = new TaskStatusRecorder(
        path.join(tmpDir, `tools-${uuidv4()}`),
      );
      await rec.initialize();
      sched = new SchedulerAgent(reg, rec);
      await sched.initialize();
    });

    afterAll(async () => {
      try { await sched?.shutdown(); } catch { /* ignore */ }
    });

    it('route_task: should create a task and it appears in the list', async () => {
      const task = makeTask({
        llmDeploymentName: 'qwen-32b',
        taskType: 'scale-up',
        priority: 'high',
      });
      await rec.createTask(task);

      const all = rec.getAllTasks();
      expect(all).toHaveLength(1);
      expect(all[0].llmDeploymentName).toBe('qwen-32b');
      expect(all[0].priority).toBe('high');

      await sched.shutdown();
    });

    it('list_agents: should return scheduler info', async () => {
      const agents = reg.getAllAgentsStatus();
      expect(agents.length).toBeGreaterThanOrEqual(1);
      const schedAgent = agents.find((a) => a.agentType === 'scheduler');
      expect(schedAgent).toBeDefined();
      expect(schedAgent!.status).toBe('Listening');

      await sched.shutdown();
    });

    it('agent_status: should return individual agent detail', async () => {
      const agents = reg.getAllAgentsStatus();
      const id = agents[0].agentId;
      const detail = reg.getAgentStatus(id);
      expect(detail).toBeDefined();
      expect(detail!.agentId).toBe(id);

      await sched.shutdown();
    });

    it('health: should return a well-formed report', async () => {
      const report = reg.getHealthReport();
      expect(report.timestamp).toBeInstanceOf(Date);
      expect(report.totalAgents).toBeGreaterThanOrEqual(1);
      expect(typeof report.uptime).toBe('number');
      expect(Array.isArray(report.agents)).toBe(true);

      await sched.shutdown();
    });

    it('task_counts: should reflect current state', async () => {
      await rec.createTask(makeTask());
      await rec.createTask(makeTask());
      const failTask = makeTask();
      await rec.createTask(failTask);
      await rec.updateTaskResult(failTask.taskId, null, 'err');

      const counts = rec.getTaskCounts();
      expect(counts.ready).toBe(2);
      expect(counts.failed).toBe(1);

      await sched.shutdown();
    });

    it('list_tasks: should filter by status', async () => {
      await rec.createTask(makeTask());
      const doneTask = makeTask();
      await rec.createTask(doneTask);
      await rec.updateTaskResult(doneTask.taskId, { ok: true }, null);

      expect(rec.getTasksByStatus('ready')).toHaveLength(1);
      expect(rec.getTasksByStatus('done')).toHaveLength(1);
      expect(rec.getAllTasks()).toHaveLength(2);

      await sched.shutdown();
    });

    it('retry_task: should reset a failed task back to ready', async () => {
      const task = makeTask();
      await rec.createTask(task);
      await rec.updateTaskResult(task.taskId, null, 'oops');
      expect(rec.getTask(task.taskId)!.status).toBe('failed');

      await rec.resetTaskForRetry(task.taskId);
      expect(rec.getTask(task.taskId)!.status).toBe('ready');
      expect(rec.getTask(task.taskId)!.retryCount).toBe(1);

      await sched.shutdown();
    });

    it('revoke_task: should expire a pending task', async () => {
      const task = makeTask();
      await rec.createTask(task);

      await rec.updateTaskStatus(task.taskId, 'expired');
      expect(rec.getTask(task.taskId)!.status).toBe('expired');

      await sched.shutdown();
    });
  });

  // ────── 6. Full flow: task through scheduler ─────────────────────────────

  describe('6 – Full flow: create → schedule → complete', () => {
    it('should move a task from ready to scheduled via the scheduler loop', async () => {
      const reg = new AgentRegistry();
      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `flow-${uuidv4()}`),
      );
      await rec.initialize();
      const sched = new SchedulerAgent(reg, rec, 3);
      (sched as any).pollingIntervalMs = 100; // fast polling for tests
      await sched.initialize();

      // Create a task
      const task = makeTask({
        llmDeploymentName: 'llama-70b',
        taskType: 'restart',
      });
      await rec.createTask(task);

      // Start the scheduler loop
      const loopPromise = sched.run();

      // Wait for the task to be scheduled
      await waitFor(() => {
        const t = rec.getTask(task.taskId);
        return t?.status === 'scheduled';
      });

      expect(rec.getTask(task.taskId)!.status).toBe('scheduled');

      // Simulate a worker completing the task
      await sched.taskCompleted(task.taskId, {
        previousReplicas: 1,
        newReplicas: 3,
      });

      const final = rec.getTask(task.taskId)!;
      expect(final.status).toBe('done');
      expect(final.result).toEqual({
        previousReplicas: 1,
        newReplicas: 3,
      });
      expect(final.completedAt).toBeDefined();

      // Verify counts reflect completion
      const counts = rec.getTaskCounts();
      expect(counts.done).toBe(1);
      expect(counts.ready).toBe(0);

      await sched.shutdown();
      await loopPromise.catch(() => {});
    });

    it('should handle multiple tasks with concurrency limit', async () => {
      const reg = new AgentRegistry();
      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `concurrency-${uuidv4()}`),
      );
      await rec.initialize();
      const sched = new SchedulerAgent(reg, rec, 2); // max 2 concurrent
      (sched as any).pollingIntervalMs = 100; // fast polling for tests
      await sched.initialize();

      // Create 4 tasks
      const tasks = [makeTask(), makeTask(), makeTask(), makeTask()];
      for (const t of tasks) await rec.createTask(t);

      // Start the scheduler loop
      const loopPromise = sched.run();

      // Wait for at least 2 to be scheduled
      await waitFor(() => {
        const scheduledCount = rec
          .getAllTasks()
          .filter((t) => t.status === 'scheduled' || t.status === 'scheduling').length;
        return scheduledCount >= 2;
      });

      // Complete the first two so more can be scheduled
      const scheduled = rec
        .getAllTasks()
        .filter((t) => t.status === 'scheduled');
      for (const t of scheduled) {
        await sched.taskCompleted(t.taskId, { ok: true });
      }

      // Wait for remaining tasks to be picked up
      await waitFor(() => {
        const allDone = rec.getAllTasks().every(
          (t) =>
            t.status === 'done' ||
            t.status === 'scheduled' ||
            t.status === 'scheduling',
        );
        return allDone;
      }, 10000);

      await sched.shutdown();
      await loopPromise.catch(() => {});

      const counts = rec.getTaskCounts();
      expect(counts.ready).toBe(0);
    });
  });

  // ────── 7. HeadAgent observe-think-decide (mocked metrics) ───────────────

  describe('7 – HeadAgent anomaly detection', () => {
    it('should boot HeadAgent and record counters (MCP errors are expected)', async () => {
      const reg = new AgentRegistry();
      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `head-${uuidv4()}`),
      );
      await rec.initialize();

      const head = new HeadAgent(reg, rec);
      // Override storage path so it uses our temp dir
      (head as any).storagePath = path.join(tmpDir, `head-data-${uuidv4()}`);
      // Reduce interval so we don't wait 5 minutes
      (head as any).snapshotInterval = 100;
      // Set staleness very high so recovered snapshots aren't discarded
      (head as any).snapshotStalenessMs = 60_000;

      await head.initialize();

      // The HeadAgent will have MCP connection errors (expected)
      const headStatus = reg
        .getAllAgentsStatus()
        .find((a) => a.agentType === 'head');
      expect(headStatus).toBeDefined();
      expect(headStatus!.status).toBe('Listening');

      // Run one cycle manually by starting the loop and letting it iterate
      const loopPromise = head.run();

      // Let it run for 2 cycles (~200ms + overhead)
      await new Promise((r) => setTimeout(r, 500));

      await (head as any).shutdown();
      await loopPromise.catch(() => {});

      // Should have collected at least 1 snapshot
      const status = reg.getAgentStatus(headStatus!.agentId);
      // Agent is deregistered after shutdown, so check snapshotHistory directly
      const history = (head as any).snapshotHistory as any[];
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].analyzed).toBe(true);
    });
  });

  // ────── 8. Persistence round-trip ────────────────────────────────────────

  describe('8 – Persistence', () => {
    it('should survive a restart: tasks persist and reload', async () => {
      const storagePath = path.join(tmpDir, `persist-e2e-${uuidv4()}`);

      // Session 1: create tasks, complete one
      const rec1 = new TaskStatusRecorder(storagePath);
      await rec1.initialize();
      const t1 = makeTask({ llmDeploymentName: 'gpt-4o' });
      const t2 = makeTask({ llmDeploymentName: 'claude-opus' });
      await rec1.createTask(t1);
      await rec1.createTask(t2);
      await rec1.updateTaskResult(t1.taskId, { done: true }, null);

      // Session 2: fresh recorder same path
      const rec2 = new TaskStatusRecorder(storagePath);
      await rec2.initialize();

      expect(rec2.getAllTasks()).toHaveLength(2);
      expect(rec2.getTask(t1.taskId)!.status).toBe('done');

      // t2 was created just now — depends on timing whether it's expired.
      // Either 'ready' (if within 60s) or 'expired' (if stale check kicks in)
      const t2Status = rec2.getTask(t2.taskId)!.status;
      expect(['ready', 'expired']).toContain(t2Status);
    });

    it('should expire stale "ready" tasks on reload', async () => {
      const storagePath = path.join(tmpDir, `stale-${uuidv4()}`);
      const rec = new TaskStatusRecorder(storagePath);
      await rec.initialize();

      // Manually write a task with old createdAt
      const oldTask = makeTask({
        createdAt: new Date(Date.now() - 120_000), // 2 minutes ago
      });
      await rec.createTask(oldTask);
      await rec.persist();

      // Reload
      const rec2 = new TaskStatusRecorder(storagePath);
      await rec2.initialize();

      expect(rec2.getTask(oldTask.taskId)!.status).toBe('expired');
    });
  });

  // ────── 9. Edge cases ────────────────────────────────────────────────────

  describe('9 – Edge cases', () => {
    it('should throw when accessing a non-existent task', async () => {
      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `edge-${uuidv4()}`),
      );
      await rec.initialize();

      await expect(
        rec.updateTaskStatus('nonexistent', 'running'),
      ).rejects.toThrow(/not found/);
    });

    it('should handle concurrent task creation', async () => {
      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `concurrent-${uuidv4()}`),
      );
      await rec.initialize();

      const tasks = Array.from({ length: 20 }, () => makeTask());
      await Promise.all(tasks.map((t) => rec.createTask(t)));

      expect(rec.getAllTasks()).toHaveLength(20);
      expect(rec.getTaskCounts().ready).toBe(20);
    });

    it('should emit events when agent status changes', async () => {
      const reg = new AgentRegistry();
      const events: string[] = [];

      reg.on('agent-status-changed', (data: any) =>
        events.push(`status:${data.status}`),
      );
      reg.on('agent-action-changed', (data: any) =>
        events.push(`action:${data.action}`),
      );

      const rec = new TaskStatusRecorder(
        path.join(tmpDir, `events-${uuidv4()}`),
      );
      await rec.initialize();
      const sched = new SchedulerAgent(reg, rec);
      await sched.initialize();

      // initialize triggers: Starting → Listening
      expect(events).toContain('status:Starting');
      expect(events).toContain('status:Listening');

      await sched.shutdown();

      expect(events).toContain('status:Stopping');
      expect(events).toContain('status:Stopped');
    });
  });
});
