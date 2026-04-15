/**
 * EngineMcpClient Tests — mock the MCP SDK to test auth lifecycle and callTool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EngineMcpClient } from '../../master/engine-mcp-client.js';

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

describe('EngineMcpClient', () => {
  let client: EngineMcpClient;
  let mockCallTool: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    client = new EngineMcpClient({
      sseUrl: 'http://localhost:31006/sse',
      username: 'testuser',
      password: 'testpass',
      tenantId: 'tenant-1',
    });

    // We need to pre-configure the mock callTool BEFORE connect() triggers auth.
    // The Client constructor is mocked, so we intercept it to seed auth_login response.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

    // Get the mock instance that will be created
    mockCallTool = vi.fn()
      // First call during connect: auth_login
      .mockResolvedValueOnce(mcpResult({ token: 'test-token-123' }));

    MockClient.mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    await client.connect();
  });

  it('authenticates on connect (login + token)', async () => {
    // The connect() in beforeEach should have called auth_login
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'auth_login',
      arguments: { username: 'testuser', password: 'testpass' },
    });
  });

  it('isConnected returns true after connect', () => {
    expect(client.isConnected).toBe(true);
  });

  it('isConnected returns false after disconnect', async () => {
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('callTool injects token and tenantId', async () => {
    // Setup: auth_login returns token (already called via connect)
    // Now set up the mock for the actual tool call
    mockCallTool.mockResolvedValueOnce(
      mcpResult({ services: [{ serviceId: '123', serviceName: 'test' }] }),
    );

    await client.callTool('model_deploy_list_services', { curPage: 1 });

    // Find the call to model_deploy_list_services
    const listCall = mockCallTool.mock.calls.find(
      (c: any) => c[0]?.name === 'model_deploy_list_services',
    );
    expect(listCall).toBeDefined();
    expect(listCall![0].arguments).toHaveProperty('token');
    expect(listCall![0].arguments).toHaveProperty('tenantId', 'tenant-1');
    expect(listCall![0].arguments).toHaveProperty('curPage', 1);
  });

  it('re-authenticates on 401 and retries', async () => {
    // First call fails with 401
    mockCallTool
      .mockRejectedValueOnce(new Error('401 Unauthorized'))
      // auth_login re-auth
      .mockResolvedValueOnce(mcpResult({ token: 'new-token' }))
      // Retry succeeds
      .mockResolvedValueOnce(mcpResult({ ok: true }));

    const result = await client.callTool('model_deploy_get_service', { serviceId: '42' });
    expect(result).toEqual({ ok: true });
  });

  it('getStatus reports connection state', () => {
    const status = client.getStatus();
    expect(status.connected).toBe(true);
    expect(status.tenantId).toBe('tenant-1');
  });
});
