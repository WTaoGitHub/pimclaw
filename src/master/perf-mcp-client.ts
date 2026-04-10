/**
 * Perf MCP Client — Stdio transport to perfllm Python MCP server.
 * Spawns a Python child process that serves the perfllm MCP tools
 * (query_perfllm, get_perfllm_schema) backed by PostgreSQL.
 */

import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface PerfMcpConfig {
  /** Path to Python interpreter. Default: "python3.12" */
  pythonPath?: string;
  /** Absolute path to perfllm_mcp_server.py */
  serverScriptPath: string;
  /** Extra environment variables passed to the Python process */
  env?: Record<string, string>;
}

export class PerfMcpClient {
  private client: MCPClient | null = null;
  private transport: StdioClientTransport | null = null;
  private config: PerfMcpConfig;

  constructor(config: PerfMcpConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const pythonPath = this.config.pythonPath ?? 'python3.12';
    this.transport = new StdioClientTransport({
      command: pythonPath,
      args: [this.config.serverScriptPath],
      env: {
        ...process.env,
        ...this.config.env,
      } as Record<string, string>,
    });
    this.client = new MCPClient(
      { name: 'pimclaw-perf', version: '1.0.0' },
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
   * Query the perfllm table with optional filters.
   * Returns the parsed result from the Python MCP server.
   */
  async queryPerfllm(args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client) throw new Error('Perf MCP client not connected');
    const result = await this.client.callTool({ name: 'query_perfllm', arguments: args });
    return this.parseToolResult(result);
  }

  /**
   * Get the schema of the perfllm table.
   */
  async getSchema(): Promise<unknown> {
    if (!this.client) throw new Error('Perf MCP client not connected');
    const result = await this.client.callTool({ name: 'get_perfllm_schema', arguments: {} });
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
          // perfllm returns markdown-formatted text, not JSON
          return { text: textContent.text };
        }
      }
    }
    return r;
  }
}
