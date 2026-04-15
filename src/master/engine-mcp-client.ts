/**
 * Engine MCP Client — SSE transport to qianjin-xuntui MCP server.
 * Handles auth lifecycle (login → token → tenant) and auto-refresh.
 * All deploy tool calls go through callTool() which auto-injects token/tenantId.
 */

import { EventSource } from 'eventsource';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface EngineMcpConfig {
  sseUrl: string;
  username: string;
  password: string;
  tenantId?: string;
  /** Refresh token this many ms before expiry. Default: 300_000 (5 min). */
  tokenRefreshMarginMs?: number;
}

export interface EngineMcpClientStatus {
  connected: boolean;
  authenticated: boolean;
  tenantId: string | null;
  tokenExpiresAt: number;
}

// Polyfill EventSource for Node.js
if (typeof globalThis.EventSource === 'undefined') {
  (globalThis as any).EventSource = EventSource;
}

export class EngineMcpClient {
  private client: MCPClient | null = null;
  private transport: SSEClientTransport | null = null;
  private config: EngineMcpConfig;
  private token: string | null = null;
  private tenantId: string | null = null;
  private tokenExpiresAt: number = 0;
  private tokenRefreshMarginMs: number;

  constructor(config: EngineMcpConfig) {
    this.config = config;
    this.tenantId = config.tenantId ?? null;
    this.tokenRefreshMarginMs = config.tokenRefreshMarginMs ?? 300_000;
  }

  async connect(): Promise<void> {
    this.transport = new SSEClientTransport(new URL(this.config.sseUrl));
    this.client = new MCPClient(
      { name: 'pimclaw-engine', version: '1.0.0' },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
    await this.authenticate();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore close errors */ }
      this.client = null;
    }
    this.transport = null;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get isConnected(): boolean {
    return this.client !== null && this.token !== null;
  }

  getStatus(): EngineMcpClientStatus {
    return {
      connected: this.client !== null,
      authenticated: this.token !== null,
      tenantId: this.tenantId,
      tokenExpiresAt: this.tokenExpiresAt,
    };
  }

  /**
   * Call an MCP tool with automatic token/tenantId injection.
   * On 401/token errors, re-authenticates and retries once.
   */
  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureAuth();

    const enrichedArgs = {
      ...args,
      token: this.token!,
      tenantId: this.tenantId!,
    };

    try {
      const result = await this.rawCallTool(toolName, enrichedArgs);
      return this.parseToolResult(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('401') || msg.toLowerCase().includes('token') || msg.toLowerCase().includes('unauthorized')) {
        await this.authenticate();
        const result = await this.rawCallTool(toolName, {
          ...args,
          token: this.token!,
          tenantId: this.tenantId!,
        });
        return this.parseToolResult(result);
      }
      throw error;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    if (!this.client) throw new Error('Engine MCP client not connected');

    // Step 1: Login
    const loginRaw = await this.rawCallTool('auth_login', {
      username: this.config.username,
      password: this.config.password,
    });
    const loginData = this.parseToolResult(loginRaw);
    const token = loginData.token as string | undefined;
    if (!token) {
      throw new Error(`auth_login did not return a token: ${JSON.stringify(loginData)}`);
    }
    this.token = token;
    // Token valid ~4h; schedule refresh before that
    this.tokenExpiresAt = Date.now() + 4 * 60 * 60 * 1000 - this.tokenRefreshMarginMs;

    // Step 2: Discover tenantId if not configured
    if (!this.tenantId) {
      const tenantsRaw = await this.rawCallTool('auth_list_tenants', { token: this.token });
      const tenantsData = this.parseToolResult(tenantsRaw);
      const rawTenants = tenantsData.tenants ?? tenantsData.data ?? tenantsData.list ?? tenantsData;
      const tenants: any[] = Array.isArray(rawTenants) ? rawTenants : [];

      if (!Array.isArray(tenants) || tenants.length === 0) {
        throw new Error('No tenants available for this account');
      }
      this.tenantId = String(tenants[0].organId ?? tenants[0].tenantId ?? tenants[0].id);
    }
  }

  private async ensureAuth(): Promise<void> {
    if (!this.client) throw new Error('Engine MCP client not connected');
    if (!this.token || Date.now() >= this.tokenExpiresAt) {
      await this.authenticate();
    }
  }

  private async rawCallTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('Engine MCP client not connected');
    return await this.client.callTool({ name: toolName, arguments: args });
  }

  private parseToolResult(result: unknown): Record<string, unknown> {
    if (typeof result !== 'object' || result === null) return {};
    const r = result as any;

    // MCP SDK returns { content: [{ type: 'text', text: '...' }] }
    if (r.content && Array.isArray(r.content)) {
      const textContent = r.content.find((c: any) => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return { raw: textContent.text };
        }
      }
    }
    return r;
  }
}
