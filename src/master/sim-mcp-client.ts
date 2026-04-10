/**
 * Sim MCP Client — SSE transport to Hisim simulation MCP server.
 * Provides hardware registration, simulation server management,
 * and benchmark serving for the Planner agent.
 * No auth lifecycle — simpler than EngineMcpClient.
 */

import { EventSource } from 'eventsource';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Polyfill EventSource for Node.js
if (typeof globalThis.EventSource === 'undefined') {
  (globalThis as any).EventSource = EventSource;
}

export interface SimMcpConfig {
  /** SSE endpoint URL of the Hisim MCP server */
  sseUrl: string;
}

export class SimMcpClient {
  private client: MCPClient | null = null;
  private transport: SSEClientTransport | null = null;
  private config: SimMcpConfig;

  constructor(config: SimMcpConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.transport = new SSEClientTransport(new URL(this.config.sseUrl));
    this.client = new MCPClient(
      { name: 'pimclaw-sim', version: '1.0.0' },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore close errors */ }
      this.client = null;
    }
    this.transport = null;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Call any Hisim MCP tool by name.
   * The Planner drives the simulation workflow via individual tool calls.
   */
  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client) throw new Error('Sim MCP client not connected');
    const result = await this.client.callTool({ name: toolName, arguments: args });
    return this.parseToolResult(result);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private parseToolResult(result: unknown): unknown {
    if (typeof result !== 'object' || result === null) return {};
    const r = result as any;

    // MCP SDK returns { content: [{ type: 'text', text: '...' }] }
    if (r.content && Array.isArray(r.content)) {
      const textContent = r.content.find((c: any) => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return { text: textContent.text };
        }
      }
    }
    return r;
  }
}
