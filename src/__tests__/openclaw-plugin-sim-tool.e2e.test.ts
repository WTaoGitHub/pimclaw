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
  parameters: Record<string, any>;
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

  it('exposes updated HiSim simulator tool schemas', () => {
    const registerTool = getTool('pimclaw_sim_register_hardware');
    const startTool = getTool('pimclaw_sim_start');
    const benchmarkTool = getTool('pimclaw_sim_benchmark');

    expect(registerTool.parameters.required).toEqual([
      'name',
      'vendor',
      'hbm_capacity_gb',
      'hbm_bandwidth_gb',
      'fp64_tflops',
      'fp32_tflops',
      'fp16_tflops',
      'int8_tflops',
    ]);
    expect(registerTool.parameters.properties).toEqual(
      expect.objectContaining({
        fp16_tensor_tflops: expect.any(Object),
        fp32_tensor_tflops: expect.any(Object),
        fp8_tensor_tflops: expect.any(Object),
        int8_tensor_tflops: expect.any(Object),
        bf16_tensor_tflops: expect.any(Object),
        ref: expect.any(Object),
      }),
    );

    expect(startTool.parameters.required).toEqual(['model_path', 'hardware_name']);
    expect(startTool.parameters.properties.port.description).toContain('8723');
    expect(startTool.parameters.properties.skip_warmup.description).toContain('false');
    expect(startTool.parameters.properties).toEqual(
      expect.objectContaining({
        database_path: expect.any(Object),
        config_path: expect.any(Object),
        host: expect.any(Object),
        model_name: expect.any(Object),
        device_name: expect.any(Object),
        kv_cache_data_type: expect.any(Object),
        backend_name: expect.any(Object),
        backend_version: expect.any(Object),
        disk_read_bandwidth_gb: expect.any(Object),
        disk_write_bandwidth_gb: expect.any(Object),
        memory_read_bandwidth_gb: expect.any(Object),
        memory_write_bandwidth_gb: expect.any(Object),
        num_device_per_node: expect.any(Object),
        hardware_info_path: expect.any(Object),
        auto_register_model: expect.any(Object),
        output_path: expect.any(Object),
      }),
    );

    expect(benchmarkTool.parameters.properties.base_url.description).toContain('8723');
    expect(benchmarkTool.parameters.properties.base_url.description).not.toContain('8001');
    expect(benchmarkTool.parameters.properties).toEqual(
      expect.objectContaining({
        random_range_ratio: expect.any(Object),
        seed: expect.any(Object),
        disable_tqdm: expect.any(Object),
        disable_stream: expect.any(Object),
        disable_ignore_eos: expect.any(Object),
        extra_request_body: expect.any(Object),
        warmup_requests: expect.any(Object),
        output_file: expect.any(Object),
        output_details: expect.any(Object),
      }),
    );
  });

  it('keeps public sim tools mapped to the expected HiSim raw tools', async () => {
    connectMock.mockResolvedValue(undefined);
    callToolMock
      .mockResolvedValueOnce({ status: 'started' })
      .mockResolvedValueOnce({ status: 'success', mean_ttft_ms: 10 })
      .mockResolvedValueOnce({ status: 'stopped' });

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

    await getTool('pimclaw_sim_start').execute('planner-session-e2e', {
      model_path: 'Qwen/Qwen2.5-7B-Instruct',
      hardware_name: 'NVIDIA H800_SXM',
    });
    await getTool('pimclaw_sim_benchmark').execute('planner-session-e2e', {
      model: 'Qwen/Qwen2.5-7B-Instruct',
    });
    await getTool('pimclaw_sim_stop').execute('planner-session-e2e', {});

    expect(callToolMock).toHaveBeenNthCalledWith(1, 'start_simulation_server', {
      model_path: 'Qwen/Qwen2.5-7B-Instruct',
      hardware_name: 'NVIDIA H800_SXM',
    });
    expect(callToolMock).toHaveBeenNthCalledWith(2, 'run_bench_serving', {
      model: 'Qwen/Qwen2.5-7B-Instruct',
    });
    expect(callToolMock).toHaveBeenNthCalledWith(3, 'stop_simulation_server', {});
  });
});
