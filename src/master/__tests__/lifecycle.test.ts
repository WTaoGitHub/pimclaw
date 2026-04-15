/**
 * Lifecycle management tests — BaseAgent, WorkerAgent abort, SchedulerAgent propagation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentRegistry } from '../component-registry.js';
import { TaskStatusRecorder } from '../task-status-recorder.js';
import { SchedulerAgent } from '../scheduler-agent.js';
import { BaseAgent } from '../base-agent.js';
import type { LifecyclePhase } from '../base-agent.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

// Minimal concrete agent for testing BaseAgent lifecycle
class TestAgent extends BaseAgent {
  public runCalled = false;
  public runAborted = false;

  constructor(registry: ComponentRegistry) {
    super('worker', registry, {
      agentId: `test-agent-${uuidv4()}`,
      agentType: 'worker',
    });
  }

  async run(): Promise<void> {
    this.runCalled = true;

    // Simulate work that respects abort
    await new Promise<void>((resolve, reject) => {
      if (this.abortController.signal.aborted) {
        this.runAborted = true;
        reject(new Error('aborted'));
        return;
      }
      const onAbort = () => {
        this.runAborted = true;
        resolve();
      };
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      // Resolve after a short delay if not aborted
      setTimeout(() => {
        this.abortController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, 50);
    });
  }
}

describe('BaseAgent lifecycle', () => {
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = new ComponentRegistry();
  });

  it('starts in init phase and transitions to running after initialize', async () => {
    const agent = new TestAgent(registry);
    expect(agent.getLifecyclePhase()).toBe('init');

    await agent.initialize();
    expect(agent.getLifecyclePhase()).toBe('running');

    await agent.shutdown();
    expect(agent.getLifecyclePhase()).toBe('stopped');
  });

  it('abort sets lifecyclePhase to aborting and signals the controller', async () => {
    const agent = new TestAgent(registry);
    await agent.initialize();

    agent.abort('test reason');
    expect(agent.getLifecyclePhase()).toBe('aborting');
    expect(agent.aborted).toBe(true);

    await agent.shutdown();
  });

  it('abort is a no-op if already stopped', async () => {
    const agent = new TestAgent(registry);
    await agent.initialize();
    await agent.shutdown();

    // Should not throw or change phase
    agent.abort('too late');
    expect(agent.getLifecyclePhase()).toBe('stopped');
  });

  it('shutdown is idempotent — calling twice does not throw', async () => {
    const agent = new TestAgent(registry);
    await agent.initialize();

    await agent.shutdown();
    await agent.shutdown(); // second call should be no-op
    expect(agent.getLifecyclePhase()).toBe('stopped');
  });

  it('trackResource cleans up resources in reverse order on shutdown', async () => {
    const agent = new TestAgent(registry);
    await agent.initialize();

    const order: string[] = [];
    (agent as any).trackResource('first', async () => { order.push('first'); });
    (agent as any).trackResource('second', async () => { order.push('second'); });
    (agent as any).trackResource('third', async () => { order.push('third'); });

    await agent.shutdown();
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('cleanup continues even when a resource cleanup throws', async () => {
    const agent = new TestAgent(registry);
    await agent.initialize();

    const cleaned: string[] = [];
    (agent as any).trackResource('good-1', async () => { cleaned.push('good-1'); });
    (agent as any).trackResource('bad', async () => { throw new Error('cleanup boom'); });
    (agent as any).trackResource('good-2', async () => { cleaned.push('good-2'); });

    await agent.shutdown();
    // Both good resources cleaned despite bad one throwing
    expect(cleaned).toEqual(['good-2', 'good-1']);
    expect(agent.getLifecyclePhase()).toBe('stopped');
  });
});

describe('SchedulerAgent abort propagation', () => {
  let registry: ComponentRegistry;
  let taskRecorder: TaskStatusRecorder;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join('./test-data', `lifecycle-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    registry = new ComponentRegistry();
    taskRecorder = new TaskStatusRecorder(testDir);
    await taskRecorder.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('scheduler run loop exits when aborted', async () => {
    const scheduler = new SchedulerAgent(registry, taskRecorder, 2);
    await scheduler.initialize();

    // Start the run loop (it's infinite, so we abort it)
    const runPromise = scheduler.run();
    scheduler.abort('test abort');
    await runPromise; // should resolve without hanging

    expect(scheduler.getLifecyclePhase()).toBe('aborting');
    await scheduler.shutdown();
  });

  it('activeWorkerCount getter reflects workers map size', async () => {
    const scheduler = new SchedulerAgent(registry, taskRecorder, 5);
    await scheduler.initialize();

    expect(scheduler.activeWorkerCount).toBe(0);

    await scheduler.shutdown();
  });
});
