/**
 * Orchestrator — the core of PimClaw's master agent.
 * Creates, manages, and coordinates sub-agents and their MCP connections.
 */

import { randomUUID } from "node:crypto";
import { McpClientManager } from "../mcp/client.js";
import type {
  AgentDefinition,
  AgentRegistryEntry,
  AgentRole,
  AgentState,
  McpServiceConfig,
} from "../types/agents.js";
import { ROLE_PROMPTS } from "../agents/prompts.js";
import { Router } from "./router.js";

export class Orchestrator {
  private registry = new Map<string, AgentRegistryEntry>();
  private mcpManagers = new Map<string, McpClientManager>();
  private router: Router;

  constructor() {
    this.router = new Router(this);
  }

  /**
   * Create a new sub-agent with the given role and connect its MCP services.
   */
  async createAgent(
    role: string,
    name: string,
    mcpServices: Record<string, McpServiceConfig> = {},
    customPrompt?: string,
  ): Promise<AgentRegistryEntry> {
    const id = `${role}-${randomUUID().slice(0, 8)}`;
    const agentRole = role as AgentRole;

    const definition: AgentDefinition = {
      id,
      role: agentRole,
      name,
      description: `${name} (${role})`,
      mcpServices,
      systemPrompt: customPrompt ?? ROLE_PROMPTS[agentRole] ?? ROLE_PROMPTS.custom,
      createdAt: Date.now(),
    };

    const state: AgentState = {
      id,
      status: "idle",
      lastActivity: Date.now(),
      taskCount: 0,
      errorCount: 0,
      lastError: null,
    };

    const entry: AgentRegistryEntry = { definition, state };

    // Connect MCP services
    const manager = new McpClientManager();
    for (const [serviceName, config] of Object.entries(mcpServices)) {
      try {
        await manager.addService(serviceName, config);
      } catch (err) {
        state.status = "error";
        state.lastError = `Failed to connect MCP service "${serviceName}": ${err instanceof Error ? err.message : String(err)}`;
        state.errorCount++;
      }
    }

    this.registry.set(id, entry);
    this.mcpManagers.set(id, manager);

    return entry;
  }

  /**
   * Terminate a sub-agent and disconnect its MCP services.
   */
  async terminateAgent(agentId: string): Promise<boolean> {
    const entry = this.registry.get(agentId);
    if (!entry) return false;

    const manager = this.mcpManagers.get(agentId);
    if (manager) {
      await manager.disconnectAll();
      this.mcpManagers.delete(agentId);
    }

    entry.state.status = "terminated";
    this.registry.delete(agentId);
    return true;
  }

  /**
   * Get a specific agent's registry entry.
   */
  getAgent(agentId: string): AgentRegistryEntry | undefined {
    return this.registry.get(agentId);
  }

  /**
   * List all registered agents with their states.
   */
  listAgents(): AgentRegistryEntry[] {
    return Array.from(this.registry.values());
  }

  /**
   * Find agents by role.
   */
  findAgentsByRole(role: AgentRole): AgentRegistryEntry[] {
    return this.listAgents().filter((e) => e.definition.role === role);
  }

  /**
   * Call an MCP tool on a sub-agent's connected service.
   */
  async callAgentMcpTool(
    agentId: string,
    serviceName: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const manager = this.mcpManagers.get(agentId);
    if (!manager) {
      return { content: [{ type: "text", text: `Agent "${agentId}" not found` }] };
    }

    const client = manager.getClient(serviceName);
    if (!client) {
      return { content: [{ type: "text", text: `Service "${serviceName}" not connected on agent "${agentId}"` }] };
    }

    const entry = this.registry.get(agentId)!;
    entry.state.status = "running";
    entry.state.lastActivity = Date.now();
    entry.state.taskCount++;

    try {
      const result = await client.callTool(toolName, args);
      entry.state.status = "idle";
      if (result.isError) {
        entry.state.errorCount++;
        entry.state.lastError = result.content[0]?.text ?? "Unknown error";
      }
      return { content: result.content };
    } catch (err) {
      entry.state.status = "error";
      entry.state.errorCount++;
      entry.state.lastError = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `MCP tool call failed: ${entry.state.lastError}` }],
      };
    }
  }

  /**
   * List all MCP tools available to a sub-agent.
   */
  async listAgentTools(
    agentId: string,
  ): Promise<Array<{ service: string; name: string; description?: string; inputSchema: unknown }>> {
    const manager = this.mcpManagers.get(agentId);
    if (!manager) return [];
    return manager.listAllTools();
  }

  /**
   * Route a task to the appropriate agent using the router.
   */
  async routeTask(
    task: string,
    targetAgentId?: string,
  ): Promise<{ agentId: string; role: string; result: string }> {
    return this.router.route(task, targetAgentId);
  }

  /**
   * Shutdown all agents and connections.
   */
  async shutdown(): Promise<void> {
    const agentIds = Array.from(this.registry.keys());
    await Promise.allSettled(agentIds.map((id) => this.terminateAgent(id)));
  }
}
