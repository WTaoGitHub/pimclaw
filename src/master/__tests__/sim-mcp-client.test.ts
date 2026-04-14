/**
 * SimMcpClient Tests — mock the MCP SDK to test lifecycle and tool calls
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimMcpClient } from '../../master/sim-mcp-client.js';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({})),
}));

// Helper: make MCP-style tool result
function mcpResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function mcpTextResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('SimMcpClient', () => {
  let client: SimMcpClient;
  let mockCallTool: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    mockCallTool = vi.fn();

    MockClient.mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    client = new SimMcpClient({
      sseUrl: 'http://192.168.4.26:8721/sse',
    });
    await client.connect();
  });

  it('isConnected returns true after connect', () => {
    expect(client.isConnected).toBe(true);
  });

  it('isConnected returns false after disconnect', async () => {
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('callTool proxies tool name and args', async () => {
    mockCallTool.mockResolvedValueOnce(
      mcpResult({ status: 'success', hardware: [{ name: 'NVIDIA H800' }] }),
    );

    const result = await client.callTool('list_all_hardware', {});

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'list_all_hardware',
      arguments: {},
    });
    expect(result).toEqual({ status: 'success', hardware: [{ name: 'NVIDIA H800' }] });
  });

  it('callTool passes complex args correctly', async () => {
    mockCallTool.mockResolvedValueOnce(
      mcpResult({ status: 'success', mean_ttft_ms: 10.5 }),
    );

    await client.callTool('run_bench_serving', {
      backend: 'sglang',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      dataset_name: 'random',
      num_prompts: 100,
    });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'run_bench_serving',
      arguments: {
        backend: 'sglang',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        dataset_name: 'random',
        num_prompts: 100,
      },
    });
  });

  it('parseToolResult handles non-JSON text content', async () => {
    mockCallTool.mockResolvedValueOnce(
      mcpTextResult('Server started successfully on port 8001'),
    );

    const result = await client.callTool('start_simulation_server', {
      model_path: 'test-model',
      hardware_name: 'NVIDIA H800',
      database_path: '/tmp/db',
    });

    expect(result).toEqual({ text: 'Server started successfully on port 8001' });
  });

  it('callTool defaults args to empty object', async () => {
    mockCallTool.mockResolvedValueOnce(mcpResult({ is_running: false }));

    await client.callTool('get_simulation_server_status');

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'get_simulation_server_status',
      arguments: {},
    });
  });

  it('throws when not connected', async () => {
    await client.disconnect();
    await expect(client.callTool('list_all_hardware')).rejects.toThrow(
      'Sim MCP client not connected',
    );
  });
});
