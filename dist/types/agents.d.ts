/**
 * Agent types — defines agent roles, states, and the registry.
 */
export type AgentRole = "perf" | "analyst" | "mon" | "sim" | "custom";
export type AgentStatus = "idle" | "running" | "error" | "terminated";
export type McpServiceConfig = {
    /** MCP server command (e.g., "node", "python") */
    command: string;
    /** Arguments to the command */
    args: string[];
    /** Environment variables for the MCP server process */
    env?: Record<string, string>;
};
export type AgentDefinition = {
    id: string;
    role: AgentRole;
    name: string;
    description: string;
    /** External MCP services this agent connects to */
    mcpServices: Record<string, McpServiceConfig>;
    /** System prompt for this agent */
    systemPrompt: string;
    /** Creation timestamp */
    createdAt: number;
};
export type AgentState = {
    id: string;
    status: AgentStatus;
    lastActivity: number;
    taskCount: number;
    errorCount: number;
    lastError: string | null;
};
export type AgentRegistryEntry = {
    definition: AgentDefinition;
    state: AgentState;
};
//# sourceMappingURL=agents.d.ts.map