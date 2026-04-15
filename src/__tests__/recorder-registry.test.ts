import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentRegistry } from '../master/component-registry.js';
import { TaskStatusRecorder } from '../master/task-status-recorder.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('TaskStatusRecorder registry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-reg-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('registers as active when registry provided', async () => {
    const registry = new ComponentRegistry();
    expect(registry.getAllAgentsStatus()).toHaveLength(0);

    const recorder = new TaskStatusRecorder(tmpDir, registry);
    await recorder.initialize();

    const agents = registry.getAllAgentsStatus();
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe('task-status-recorder');
    expect(agents[0].agentType).toBe('recorder');
    expect(agents[0].status).toBe('Listening');
  });

  it('works without registry (backward compat)', async () => {
    const recorder = new TaskStatusRecorder(tmpDir);
    await recorder.initialize();
    // No throw = success
  });
});
