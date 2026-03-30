/**
 * MCP client wrapper — connects to external MCP services (perf, mon, sim)
 * and exposes their tools for use by PimClaw sub-agents.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServiceConfig } from "../types/agents.js";

export type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

export class McpClientWrapper {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private _connected = false;

  constructor(
    private readonly name: string,
    private readonly config: McpServiceConfig,
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...this.config.env } as Record<string, string>,
    });

    this.client = new Client(
      { name: `pimclaw-${this.name}`, version: "0.1.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this._connected || !this.client) return;
    await this.client.close();
    this.client = null;
    this.transport = null;
    this._connected = false;
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    if (!this.client) throw new Error(`MCP client "${this.name}" not connected`);
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    if (!this.client) throw new Error(`MCP client "${this.name}" not connected`);
    const result = await this.client.callTool({ name: toolName, arguments: args });
    return {
      content: (result.content as Array<{ type: string; text: string }>) ?? [],
      isError: result.isError as boolean | undefined,
    };
  }
}

/**
 * Manages multiple MCP client connections for a sub-agent.
 */
export class McpClientManager {
  private clients = new Map<string, McpClientWrapper>();

  async addService(name: string, config: McpServiceConfig): Promise<void> {
    const client = new McpClientWrapper(name, config);
    await client.connect();
    this.clients.set(name, client);
  }

  async removeService(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
  }

  getClient(name: string): McpClientWrapper | undefined {
    return this.clients.get(name);
  }

  listServices(): string[] {
    return Array.from(this.clients.keys());
  }

  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.clients.values()).map((c) => c.disconnect());
    await Promise.allSettled(promises);
    this.clients.clear();
  }

  /**
   * List all tools from all connected MCP services, prefixed with service name.
   */
  async listAllTools(): Promise<Array<{ service: string; name: string; description?: string; inputSchema: unknown }>> {
    const results: Array<{ service: string; name: string; description?: string; inputSchema: unknown }> = [];
    for (const [serviceName, client] of this.clients) {
      if (!client.connected) continue;
      const tools = await client.listTools();
      for (const tool of tools) {
        results.push({ service: serviceName, ...tool });
      }
    }
    return results;
  }
}
