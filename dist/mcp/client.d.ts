/**
 * MCP client wrapper — connects to external MCP services (perf, mon, sim)
 * and exposes their tools for use by PimClaw sub-agents.
 */
import type { McpServiceConfig } from "../types/agents.js";
export type McpToolResult = {
    content: Array<{
        type: string;
        text: string;
    }>;
    isError?: boolean;
};
export declare class McpClientWrapper {
    private readonly name;
    private readonly config;
    private client;
    private transport;
    private _connected;
    constructor(name: string, config: McpServiceConfig);
    get connected(): boolean;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    listTools(): Promise<Array<{
        name: string;
        description?: string;
        inputSchema: unknown;
    }>>;
    callTool(toolName: string, args?: Record<string, unknown>): Promise<McpToolResult>;
}
/**
 * Manages multiple MCP client connections for a sub-agent.
 */
export declare class McpClientManager {
    private clients;
    addService(name: string, config: McpServiceConfig): Promise<void>;
    removeService(name: string): Promise<void>;
    getClient(name: string): McpClientWrapper | undefined;
    listServices(): string[];
    disconnectAll(): Promise<void>;
    /**
     * List all tools from all connected MCP services, prefixed with service name.
     */
    listAllTools(): Promise<Array<{
        service: string;
        name: string;
        description?: string;
        inputSchema: unknown;
    }>>;
}
//# sourceMappingURL=client.d.ts.map