import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (options: unknown) => options,
}), { virtual: true });

type RegisteredTool = {
  name: string;
  execute: (sessionId: string, params: Record<string, unknown>) => Promise<{ output: string }>;
};

describe('openclaw plugin plan task tool', () => {
  let tempRoot: string;
  let stateDir: string;
  let workspaceDir: string;
  let registeredService: any;
  let pluginEntry: any;
  const registeredTools: Array<() => RegisteredTool> = [];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-plugin-plan-task-'));
    stateDir = path.join(tempRoot, 'state');
    workspaceDir = path.join(tempRoot, 'workspace');
    await fs.mkdir(path.join(stateDir, 'pimclaw-tasks'), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    const nowIso = new Date().toISOString();

    const seededTasks = Object.fromEntries(
      Array.from({ length: 1002 }, (_, index) => {
        const taskId = `task-plan-${index}`;
        return [taskId, {
          taskId,
          status: 'planning',
          createdAt: nowIso,
          statusModifiedAt: nowIso,
          priority: 'high',
          llmDeploymentName: `deployment-${index}`,
          taskType: 'scale-up',
          taskData: {
            events: [
              {
                eventId: `evt-${index}`,
                metricName: 'ttft',
                severity: 'high',
                currentValue: 0.45,
                previousValue: 0.15,
              },
            ],
          },
          retryCount: 0,
          maxRetries: 3,
        }];
      }),
    );

    await fs.writeFile(
      path.join(stateDir, 'pimclaw-tasks', 'tasks.json'),
      JSON.stringify(seededTasks, null, 2),
      'utf-8',
    );

    ({ default: pluginEntry } = await import('../openclaw-plugin.js'));

    pluginEntry.register({
      id: 'pimclaw',
      name: 'PimClaw',
      source: 'test',
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      pluginConfig: {},
      runtime: {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerService(service: any) {
        registeredService = service;
      },
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerCliBackend() {},
      registerProvider() {},
      registerSpeechProvider() {},
      registerMediaUnderstandingProvider() {},
      registerImageGenerationProvider() {},
      registerWebSearchProvider() {},
      registerInteractiveHandler() {},
      registerCommand() {},
      registerContextEngine() {},
      registerMemoryPromptSection() {},
      config: {},
    } as any);

    await registeredService.start({
      config: {},
      stateDir,
      workspaceDir,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
    });
  });

  afterEach(async () => {
    if (registeredService) {
      await registeredService.stop({
        config: {},
        stateDir,
        workspaceDir,
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
        },
      });
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
    registeredTools.length = 0;
    registeredService = null;
  });

  function getTool(name: string): RegisteredTool {
    const factory = registeredTools.find((candidate) => candidate().name === name);
    if (!factory) {
      throw new Error(`Tool ${name} was not registered`);
    }
    return factory();
  }

  it('persists the submitted planner payload in planner-output-format-debug.jsonl', async () => {
    const planTaskTool = getTool('pimclaw_plan_task');
    const submission = {
      taskId: 'task-plan-0',
      taskType: 'reconfigure',
      config: {
        replicas: 2,
        dtype: 'bf16',
        quantization: null,
        maxBatchSize: 32,
        tensorParallelism: 8,
      },
      reasoning: 'Selected the smallest config change that reduces TTFT regression.',
      perfEvidence: 'Historical perf shows bf16 with tp=8 met target TTFT.',
      simulationResults: 'Simulation predicts TTFT 95ms at the observed QPS.',
    };

    const response = await planTaskTool.execute('planner-session-e2e', submission);
    expect(JSON.parse(response.output)).toMatchObject({
      success: true,
      taskId: 'task-plan-0',
    });

    const debugFilePath = path.join(
      workspaceDir,
      '.pimclaw-agents',
      'planner',
      'planner-output-format-debug.jsonl',
    );
    const debugLines = (await fs.readFile(debugFilePath, 'utf-8'))
      .trim()
      .split('\n');

    expect(debugLines).toHaveLength(1);
    expect(JSON.parse(debugLines[0])).toEqual({
      ...submission,
      reasoning: `${submission.reasoning} Fallback plan applied without full evidence because Perf MCP is unavailable and Simulator MCP is unavailable.`,
      perfEvidence: 'UNAVAILABLE: Perf MCP not configured or unavailable.',
      simulationResults: 'UNAVAILABLE: Simulator MCP not configured or unavailable.',
    });
  });

  it('stores normalized UNAVAILABLE evidence on the task when MCPs are unavailable', async () => {
    const planTaskTool = getTool('pimclaw_plan_task');

    await planTaskTool.execute('planner-session-e2e', {
      taskId: 'task-plan-1',
      taskType: 'reconfigure',
      config: {
        replicas: 2,
        dtype: 'bf16',
      },
      reasoning: 'Selected the smallest config change that reduces TTFT regression.',
      perfEvidence: 'Pretend historical evidence',
      simulationResults: 'Pretend simulation evidence',
    });

    const persistedTasks = JSON.parse(
      await fs.readFile(path.join(stateDir, 'pimclaw-tasks', 'tasks.json'), 'utf-8'),
    );

    expect(persistedTasks['task-plan-1']).toMatchObject({
      status: 'ready',
      perfEvidence: 'UNAVAILABLE: Perf MCP not configured or unavailable.',
      simulationResults: 'UNAVAILABLE: Simulator MCP not configured or unavailable.',
    });
    expect(persistedTasks['task-plan-1'].reasoning).toContain(
      'Fallback plan applied without full evidence because Perf MCP is unavailable and Simulator MCP is unavailable.',
    );
  });

  it('keeps only the newest 1000 planner payloads', async () => {
    const planTaskTool = getTool('pimclaw_plan_task');

    for (let index = 0; index < 1002; index += 1) {
      await planTaskTool.execute('planner-session-e2e', {
        taskId: `task-plan-${index}`,
        taskType: 'scale-up',
        config: {
          replicas: 2,
          dtype: 'bf16',
        },
        reasoning: `Reasoning ${index}`,
        perfEvidence: `Perf ${index}`,
        simulationResults: `Sim ${index}`,
      });
    }

    const debugFilePath = path.join(
      workspaceDir,
      '.pimclaw-agents',
      'planner',
      'planner-output-format-debug.jsonl',
    );
    const debugLines = (await fs.readFile(debugFilePath, 'utf-8'))
      .trim()
      .split('\n');

    expect(debugLines).toHaveLength(1000);
    expect(JSON.parse(debugLines[0]).taskId).toBe('task-plan-2');
    expect(JSON.parse(debugLines[999]).taskId).toBe('task-plan-1001');
  });
});