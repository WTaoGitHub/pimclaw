/**
 * PerfMcpClient Tests — mock the MCP SDK to test lifecycle and tool calls
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PerfMcpClient } from '../../master/perf-mcp-client.js';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

// Helper: make MCP-style tool result
function mcpResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('PerfMcpClient', () => {
  let client: PerfMcpClient;
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

    client = new PerfMcpClient({
      pythonPath: 'python3.12',
      serverScriptPath: '/tmp/perfllm_mcp_server.py',
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

  it('queryPerfllm calls query_perfllm tool with args', async () => {
    mockCallTool.mockResolvedValueOnce(
      mcpResult('## perfllm Query Results\n\nFound 1 row(s):\n\n### Entry\n- **model_name**: Qwen3\n'),
    );

    const result = await client.queryPerfllm({ model_name: 'Qwen3', limit: 5 });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'query_perfllm',
      arguments: { model_name: 'Qwen3', limit: 5 },
    });
    // Markdown text is returned as { text: ... } since it's not valid JSON
    expect(result).toHaveProperty('text');
  });

  it('queryPerfllm passes empty args when none specified', async () => {
    mockCallTool.mockResolvedValueOnce(mcpResult('No results found.'));

    await client.queryPerfllm();

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'query_perfllm',
      arguments: {},
    });
  });

  it('getSchema calls get_perfllm_schema tool', async () => {
    mockCallTool.mockResolvedValueOnce(
      mcpResult('## perfllm Table Schema\n\n| Column | Type | Nullable |'),
    );

    const result = await client.getSchema();

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'get_perfllm_schema',
      arguments: {},
    });
    expect(result).toHaveProperty('text');
  });

  it('parseToolResult handles JSON content', async () => {
    mockCallTool.mockResolvedValueOnce(
      mcpResult(JSON.stringify({ rows: [{ model_name: 'test' }] })),
    );

    const result = await client.queryPerfllm({ model_name: 'test' });
    expect(result).toEqual({ rows: [{ model_name: 'test' }] });
  });

  it('throws when not connected', async () => {
    await client.disconnect();
    await expect(client.queryPerfllm()).rejects.toThrow('Perf MCP client not connected');
    await expect(client.getSchema()).rejects.toThrow('Perf MCP client not connected');
  });
});
