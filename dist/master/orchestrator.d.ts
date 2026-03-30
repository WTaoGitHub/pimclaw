/**
 * Orchestrator — the core of PimClaw's master agent.
 * Creates, manages, and coordinates sub-agents and their MCP connections.
 */
import type { AgentRegistryEntry, AgentRole, McpServiceConfig } from "../types/agents.js";
export declare class Orchestrator {
    private registry;
    private mcpManagers;
    private router;
    constructor();
    /**
     * Create a new sub-agent with the given role and connect its MCP services.
     */
    createAgent(role: string, name: string, mcpServices?: Record<string, McpServiceConfig>, customPrompt?: string): Promise<AgentRegistryEntry>;
    /**
     * Terminate a sub-agent and disconnect its MCP services.
     */
    terminateAgent(agentId: string): Promise<boolean>;
    /**
     * Get a specific agent's registry entry.
     */
    getAgent(agentId: string): AgentRegistryEntry | undefined;
    /**
     * List all registered agents with their states.
     */
    listAgents(): AgentRegistryEntry[];
    /**
     * Find agents by role.
     */
    findAgentsByRole(role: AgentRole): AgentRegistryEntry[];
    /**
     * Call an MCP tool on a sub-agent's connected service.
     */
    callAgentMcpTool(agentId: string, serviceName: string, toolName: string, args?: Record<string, unknown>): Promise<{
        content: Array<{
            type: string;
            text: string;
        }>;
    }>;
    /**
     * List all MCP tools available to a sub-agent.
     */
    listAgentTools(agentId: string): Promise<Array<{
        service: string;
        name: string;
        description?: string;
        inputSchema: unknown;
    }>>;
    /**
     * Route a task to the appropriate agent using the router.
     */
    routeTask(task: string, targetAgentId?: string): Promise<{
        agentId: string;
        role: string;
        result: string;
    }>;
    /**
     * Shutdown all agents and connections.
     */
    shutdown(): Promise<void>;
}
//# sourceMappingURL=orchestrator.d.ts.map