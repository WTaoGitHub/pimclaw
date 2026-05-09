import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (options: unknown) => options,
}), { virtual: true });

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const callToolMock = vi.fn();

vi.mock('../master/sim-mcp-client.js', () => ({
  SimMcpClient: class MockSimMcpClient {
    async connect() {
      return connectMock();
    }

    async disconnect() {
      return disconnectMock();
    }

    get isConnected() {
      return true;
    }

    async callTool(toolName: string, args: Record<string, unknown>) {
      return callToolMock(toolName, args);
    }
  },
}));

type RegisteredTool = {
  name: string;
  execute: (sessionId: string, params: Record<string, unknown>) => Promise<{ output: string }>;
};

describe('openclaw plugin sim tool', () => {
  let tempRoot: string;
  let stateDir: string;
  let workspaceDir: string;
  let registeredService: any;
  let pluginEntry: any;
  const registeredTools: Array<() => RegisteredTool> = [];

  beforeEach(async () => {
    vi.resetModules();
    connectMock.mockReset();
    disconnectMock.mockReset();
    callToolMock.mockReset();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-plugin-sim-tool-'));
    stateDir = path.join(tempRoot, 'state');
    workspaceDir = path.join(tempRoot, 'workspace');
    await fs.mkdir(path.join(stateDir, 'pimclaw-tasks'), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

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

  it('reconnects sim MCP on tool execution after startup connection failure', async () => {
    connectMock
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 192.168.4.26:8721'))
      .mockResolvedValueOnce(undefined);
    callToolMock.mockResolvedValueOnce({ items: [{ name: 'nvidia/h800' }] });

    await registeredService.start({
      config: {
        simMcp: {
          sseUrl: 'http://192.168.4.26:8721/sse',
        },
      },
      stateDir,
      workspaceDir,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
    });

    const simListHardwareTool = getTool('pimclaw_sim_list_hardware');
    const response = await simListHardwareTool.execute('planner-session-e2e', {});

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(callToolMock).toHaveBeenCalledWith('list_all_hardware', {});
    expect(JSON.parse(response.output)).toEqual({ items: [{ name: 'nvidia/h800' }] });
  });
});