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

describe('openclaw plugin Head feedback tool', () => {
  let tempRoot: string;
  let stateDir: string;
  let workspaceDir: string;
  let registeredService: any;
  let pluginEntry: any;
  const registeredTools: Array<() => RegisteredTool> = [];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-plugin-feedback-'));
    stateDir = path.join(tempRoot, 'state');
    workspaceDir = path.join(tempRoot, 'workspace');
    await fs.mkdir(path.join(stateDir, 'pimclaw-tasks'), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    const seededTasks = {
      'task-head-feedback-1': {
        taskId: 'task-head-feedback-1',
        status: 'done',
        createdAt: '2026-04-22T00:00:00.000Z',
        statusModifiedAt: '2026-04-22T00:20:00.000Z',
        priority: 'high',
        llmDeploymentName: 'minimax-m2-1-prod',
        taskType: 'scale-up',
        taskData: {
          events: [
            {
              eventId: 'evt-1',
              metricName: 'ttft',
              severity: 'high',
              currentValue: 0.45,
              previousValue: 0.15,
            },
          ],
        },
        retryCount: 0,
        maxRetries: 3,
        completedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        feedback: {
          version: 1,
          statusSummary: 'completed-successfully',
          outcome: 'unknown',
          source: 'system',
          generatedAt: '2026-04-22T00:21:00.000Z',
          summary: 'Task completed successfully for minimax-m2-1-prod.',
        },
      },
    };

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
      pluginConfig: {
        headFeedback: {
          settlingDelayMs: 5 * 60 * 1000,
          feedbackValidityMs: 90 * 60 * 1000,
        },
      },
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

  it('updates a completed task through the registered feedback tool and refreshes planner memory', async () => {
    const feedbackTool = getTool('pimclaw_submit_task_feedback');
    const listTasksTool = getTool('pimclaw_list_tasks');

    const response = await feedbackTool.execute('head-session-e2e', {
      taskId: 'task-head-feedback-1',
      outcome: 'unknown',
      statusSummary: 'completed-successfully',
      summary: 'TTFT recovered after the scale-up.',
      metricAssessments: [
        {
          metricName: 'ttft',
          direction: 'improved',
          previousValue: 0.45,
          currentValue: 0.21,
          delta: -0.24,
          percentChange: -53.33,
        },
        {
          metricName: 'qps',
          direction: 'unchanged',
          previousValue: 12,
          currentValue: 12.2,
          delta: 0.2,
          percentChange: 1.67,
        },
      ],
    });

    expect(JSON.parse(response.output)).toMatchObject({
      success: true,
      taskId: 'task-head-feedback-1',
      feedbackSource: 'head-followup',
      reviewState: 'applied',
    });

    const listedTasks = JSON.parse((await listTasksTool.execute('head-session-e2e', { status: 'done', limit: 10 })).output);
    expect(listedTasks).toHaveLength(1);
    expect(listedTasks[0].feedback).toMatchObject({
      source: 'head-followup',
      outcome: 'helped',
      statusSummary: 'completed-successfully',
      summary: 'TTFT recovered after the scale-up.',
    });
    expect(listedTasks[0].feedback.details.metricAssessments).toHaveLength(2);

    const plannerEpisodes = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, '.pimclaw-agents', 'planner', 'memory', 'episodes.json'),
        'utf-8',
      ),
    );
    expect(plannerEpisodes[0].taskId).toBe('task-head-feedback-1');
    expect(plannerEpisodes[0].feedback.outcome).toBe('helped');
  });
});