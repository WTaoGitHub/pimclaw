/**
 * Base Agent class for PimClaw agents
 * All agents inherit from this
 */

import { AgentRuntimeStatus, AgentType, AgentStatus, AgentConfig } from '../types/index.js';
import { AgentRegistry } from './agent-registry.js';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Base class for all PimClaw agents
 */
export abstract class BaseAgent {
  protected agentId: string;
  protected agentType: AgentType;
  protected status: AgentStatus = 'Starting';
  protected registry: AgentRegistry;
  protected config: AgentConfig;
  protected mcpClients: Map<string, MCPClient> = new Map();
  protected startedAt: Date;

  constructor(agentType: AgentType, registry: AgentRegistry, config?: AgentConfig) {
    this.agentType = agentType;
    this.registry = registry;
    this.agentId = config?.agentId || `${agentType}-${uuidv4()}`;
    this.config = config || {
      agentId: this.agentId,
      agentType: agentType,
    };
    this.startedAt = new Date();
  }

  /**
   * Initialize the agent (load config, connect to MCP services, etc.)
   */
  async initialize(): Promise<void> {
    // Register first so subsequent updateStatus calls can find the agent
    this.registerInRegistry();

    this.updateStatus('Starting');

    // Connect to MCP services
    await this.connectToMCPServices();

    this.updateStatus('Listening');
  }

  /**
   * Connect to all configured MCP services
   */
  protected async connectToMCPServices(): Promise<void> {
    if (!this.config.mcpServices) {
      return;
    }

    for (const [serviceName, serviceConfig] of Object.entries(
      this.config.mcpServices
    )) {
      try {
        // Create stdio transport
        const transport = new StdioClientTransport({
          command: serviceConfig.command,
          args: serviceConfig.args || [],
          env: serviceConfig.env,
        });

        // Create MCP client
        const client = new MCPClient(
          { name: `pimclaw-${this.agentType}`, version: '1.0.0' },
          { capabilities: {} },
        );

        await client.connect(transport);
        this.mcpClients.set(serviceName, client);
        this.registry.updateMCPConnection(this.agentId, serviceName, 'connected');
      } catch (error) {
        console.error(`Failed to connect to MCP service ${serviceName}:`, error);
        this.registry.updateMCPConnection(
          this.agentId,
          serviceName,
          'error'
        );
        this.registry.recordError(
          this.agentId,
          `Failed to connect to MCP service ${serviceName}`
        );
      }
    }
  }

  /**
   * Call a tool on an MCP service (SDK mode)
   */
  protected async callMCPTool(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = this.mcpClients.get(serviceName);
    if (!client) {
      throw new Error(`MCP service ${serviceName} not connected`);
    }

    try {
      // Assuming MCP SDK has a call method for tools
      // This would be implementation-dependent on the actual SDK
      const result = await (client as any).callTool(toolName, args);
      this.registry.updateMCPConnection(this.agentId, serviceName, 'connected');
      return result;
    } catch (error) {
      this.registry.updateMCPConnection(this.agentId, serviceName, 'error');
      this.registry.recordError(
        this.agentId,
        `MCP tool call failed: ${toolName} on ${serviceName}`
      );
      throw error;
    }
  }

  /**
   * Call a tool via MCP-CLI (shell mode)
   * This is used for on-demand discovery and Unix piping
   */
  protected async callMCPToolViaCLI(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown>,
    pipeCommand?: string
  ): Promise<unknown> {
    // This would be implemented to spawn a subprocess
    // pimclaw mcp call <service> <tool> <args> | <pipeCommand>
    // For now, throwing as this requires subprocess invocation
    throw new Error('MCP-CLI calls require proper subprocess integration');
  }

  /**
   * Update agent status
   */
  protected updateStatus(status: AgentStatus): void {
    this.status = status;
    this.registry.updateAgentStatus(this.agentId, status);
  }

  /**
   * Update current action
   */
  protected updateAction(action: string | undefined): void {
    this.registry.updateAgentAction(this.agentId, action);
  }

  /**
   * Register this agent in the registry
   */
  private registerInRegistry(): void {
    const status: AgentRuntimeStatus = {
      agentId: this.agentId,
      agentType: this.agentType,
      status: 'Starting',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      mcpConnections: {},
      counters: {},
      errors: {
        errorCount: 0,
      },
    };
    this.registry.registerAgent(status);
  }

  /**
   * Shutdown the agent
   */
  async shutdown(): Promise<void> {
    this.updateStatus('Stopping');

    // Close all MCP connections
    for (const client of this.mcpClients.values()) {
      await client.close();
    }

    this.updateStatus('Stopped');
    this.registry.deregisterAgent(this.agentId);
  }

  /**
   * Abstract method: run the agent's main loop
   */
  abstract run(): Promise<void>;

  /**
   * Get this agent's current runtime status
   */
  getRuntimeStatus(): AgentRuntimeStatus | undefined {
    return this.registry.getAgentStatus(this.agentId);
  }
}
