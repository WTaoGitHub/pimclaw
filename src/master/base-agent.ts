/**
 * Base Agent class for PimClaw agents
 * All agents inherit from this
 */

import { AgentRuntimeStatus, AgentType, AgentStatus, AgentConfig } from '../types/index.js';
import { ComponentRegistry } from './component-registry.js';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Lifecycle phases for agent runtime management.
 * Transitions: init → running → aborting? → cleanup → stopped
 *                                                   → error
 */
export type LifecyclePhase = 'init' | 'running' | 'aborting' | 'cleanup' | 'stopped' | 'error';

/**
 * A tracked resource that must be cleaned up when the agent shuts down.
 */
interface OwnedResource {
  name: string;
  cleanup: () => Promise<void>;
}

/**
 * Base class for all PimClaw agents
 */
export abstract class BaseAgent {
  protected agentId: string;
  protected agentType: AgentType;
  protected status: AgentStatus = 'Starting';
  protected lifecyclePhase: LifecyclePhase = 'init';
  protected registry: ComponentRegistry;
  protected config: AgentConfig;
  protected mcpClients: Map<string, MCPClient> = new Map();
  protected startedAt: Date;
  protected abortController: AbortController = new AbortController();
  private ownedResources: OwnedResource[] = [];

  constructor(agentType: AgentType, registry: ComponentRegistry, config?: AgentConfig) {
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
   * Track a resource that must be cleaned up on shutdown.
   * Resources are cleaned up in reverse order (last registered, first cleaned).
   */
  protected trackResource(name: string, cleanup: () => Promise<void>): void {
    this.ownedResources.push({ name, cleanup });
  }

  /**
   * Abort the agent. Signals the abort controller and transitions to 'aborting' phase.
   */
  abort(reason?: string): void {
    if (this.lifecyclePhase === 'stopped' || this.lifecyclePhase === 'cleanup') {
      return;
    }
    this.lifecyclePhase = 'aborting';
    this.abortController.abort(reason ?? 'agent aborted');
  }

  /**
   * Whether this agent has been aborted.
   */
  get aborted(): boolean {
    return this.abortController.signal.aborted;
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

    this.lifecyclePhase = 'running';
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

        // Track MCP client for deterministic cleanup
        this.trackResource(`mcp:${serviceName}`, async () => {
          try {
            await client.close();
          } catch {
            // Connection may already be closed
          }
          this.mcpClients.delete(serviceName);
        });
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
   * Shutdown the agent. Cleans up all owned resources in reverse order,
   * then deregisters from the registry.
   */
  async shutdown(): Promise<void> {
    if (this.lifecyclePhase === 'cleanup' || this.lifecyclePhase === 'stopped') {
      return; // prevent double-shutdown
    }

    this.lifecyclePhase = 'cleanup';
    this.updateStatus('Stopping');

    // Clean up owned resources in reverse order (last registered first)
    for (const resource of [...this.ownedResources].reverse()) {
      try {
        await resource.cleanup();
      } catch (err) {
        this.registry.recordError(
          this.agentId,
          `Cleanup failed for ${resource.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    this.ownedResources = [];

    // Close any MCP clients not tracked via trackResource (backward compat)
    for (const client of this.mcpClients.values()) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    this.mcpClients.clear();

    this.lifecyclePhase = 'stopped';
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

  /**
   * Get the current lifecycle phase
   */
  getLifecyclePhase(): LifecyclePhase {
    return this.lifecyclePhase;
  }
}
