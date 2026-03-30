/**
 * MCP client wrapper — connects to external MCP services (perf, mon, sim)
 * and exposes their tools for use by PimClaw sub-agents.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export class McpClientWrapper {
    name;
    config;
    client = null;
    transport = null;
    _connected = false;
    constructor(name, config) {
        this.name = name;
        this.config = config;
    }
    get connected() {
        return this._connected;
    }
    async connect() {
        if (this._connected)
            return;
        this.transport = new StdioClientTransport({
            command: this.config.command,
            args: this.config.args,
            env: { ...process.env, ...this.config.env },
        });
        this.client = new Client({ name: `pimclaw-${this.name}`, version: "0.1.0" }, { capabilities: {} });
        await this.client.connect(this.transport);
        this._connected = true;
    }
    async disconnect() {
        if (!this._connected || !this.client)
            return;
        await this.client.close();
        this.client = null;
        this.transport = null;
        this._connected = false;
    }
    async listTools() {
        if (!this.client)
            throw new Error(`MCP client "${this.name}" not connected`);
        const result = await this.client.listTools();
        return result.tools;
    }
    async callTool(toolName, args = {}) {
        if (!this.client)
            throw new Error(`MCP client "${this.name}" not connected`);
        const result = await this.client.callTool({ name: toolName, arguments: args });
        return {
            content: result.content ?? [],
            isError: result.isError,
        };
    }
}
/**
 * Manages multiple MCP client connections for a sub-agent.
 */
export class McpClientManager {
    clients = new Map();
    async addService(name, config) {
        const client = new McpClientWrapper(name, config);
        await client.connect();
        this.clients.set(name, client);
    }
    async removeService(name) {
        const client = this.clients.get(name);
        if (client) {
            await client.disconnect();
            this.clients.delete(name);
        }
    }
    getClient(name) {
        return this.clients.get(name);
    }
    listServices() {
        return Array.from(this.clients.keys());
    }
    async disconnectAll() {
        const promises = Array.from(this.clients.values()).map((c) => c.disconnect());
        await Promise.allSettled(promises);
        this.clients.clear();
    }
    /**
     * List all tools from all connected MCP services, prefixed with service name.
     */
    async listAllTools() {
        const results = [];
        for (const [serviceName, client] of this.clients) {
            if (!client.connected)
                continue;
            const tools = await client.listTools();
            for (const tool of tools) {
                results.push({ service: serviceName, ...tool });
            }
        }
        return results;
    }
}
//# sourceMappingURL=client.js.map