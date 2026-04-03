/**
 * Agent Registry - Central tracking of all live agents and their runtime status
 */

import { EventEmitter } from 'events';
import {
  AgentRuntimeStatus,
  AgentType,
  AgentStatus,
  AgentCounters,
  AgentErrors,
  MCPConnectionStatus,
} from '../types/index.js';

/**
 * Central registry for all live agents in PimClaw
 * Maintains runtime status of all active agents and exposes it via MCP tools
 */
export class ComponentRegistry extends EventEmitter {
  private agents: Map<string, AgentRuntimeStatus> = new Map();
  private readonly startTime = new Date();

  /**
   * Register or update an agent's runtime status
   */
  public registerAgent(status: AgentRuntimeStatus): void {
    this.agents.set(status.agentId, status);
    this.emit('agent-updated', status);
  }

  /**
   * Update an agent's status field
   */
  public updateAgentStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in registry`);
    }
    agent.status = status;
    if (status === 'Listening' && !agent.listeningAt) {
      agent.listeningAt = new Date();
    }
    agent.lastActivityAt = new Date();
    this.emit('agent-status-changed', { agentId, status });
  }

  /**
   * Update an agent's current action
   */
  public updateAgentAction(agentId: string, action: string | undefined): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in registry`);
    }
    agent.currentAction = action;
    agent.lastActivityAt = new Date();
    this.emit('agent-action-changed', { agentId, action });
  }

  /**
   * Update MCP connection status for an agent
   */
  public updateMCPConnection(
    agentId: string,
    serviceName: string,
    status: MCPConnectionStatus
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in registry`);
    }
    agent.mcpConnections[serviceName] = status;
    agent.lastActivityAt = new Date();
    this.emit('mcp-connection-changed', { agentId, serviceName, status });
  }

  /**
   * Update counters for an agent
   */
  public updateCounters(agentId: string, counters: Partial<AgentCounters>): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in registry`);
    }
    agent.counters = { ...agent.counters, ...counters };
    agent.lastActivityAt = new Date();
  }

  /**
   * Record an error for an agent
   */
  public recordError(agentId: string, error: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in registry`);
    }
    agent.errors.errorCount++;
    agent.errors.lastError = error;
    agent.errors.lastErrorAt = new Date();
    agent.lastActivityAt = new Date();
    this.emit('agent-error', { agentId, error });
  }

  /**
   * Get a single agent's status
   */
  public getAgentStatus(agentId: string): AgentRuntimeStatus | undefined {
    const agent = this.agents.get(agentId);
    if (agent) {
      // Calculate uptime
      if (agent.listeningAt) {
        agent.uptime = new Date().getTime() - agent.listeningAt.getTime();
      }
    }
    return agent;
  }

  /**
   * Get all agents' status
   */
  public getAllAgentsStatus(): AgentRuntimeStatus[] {
    const result: AgentRuntimeStatus[] = [];
    for (const agent of this.agents.values()) {
      // Calculate uptime for each
      if (agent.listeningAt) {
        agent.uptime = new Date().getTime() - agent.listeningAt.getTime();
      }
      result.push(agent);
    }
    return result;
  }

  /**
   * Get agents by type
   */
  public getAgentsByType(type: AgentType): AgentRuntimeStatus[] {
    return this.getAllAgentsStatus().filter((agent) => agent.agentType === type);
  }

  /**
   * Deregister an agent (when it stops)
   */
  public deregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.emit('agent-deregistered', agentId);
  }

  /**
   * Get system-wide health report
   */
  public getHealthReport(): HealthReport {
    const agents = this.getAllAgentsStatus();
    const errors = agents.reduce((sum, a) => sum + a.errors.errorCount, 0);
    const healthy = agents.filter(
      (a) => a.status === 'Listening' && a.errors.errorCount === 0
    ).length;

    return {
      timestamp: new Date(),
      uptime: new Date().getTime() - this.startTime.getTime(),
      totalAgents: agents.length,
      healthyAgents: healthy,
      totalErrors: errors,
      agents,
      issues: this.detectIssues(agents),
    };
  }

  /**
   * Detect health issues
   */
  private detectIssues(agents: AgentRuntimeStatus[]): HealthIssue[] {
    const issues: HealthIssue[] = [];

    for (const agent of agents) {
      // Error rate > 50%
      if (agent.errors.errorCount > 5) {
        issues.push({
          severity: 'error',
          agentId: agent.agentId,
          message: `Agent ${agent.agentId} has ${agent.errors.errorCount} errors`,
        });
      }

      // Agent not listening but should be
      if (agent.status !== 'Listening' && agent.status !== 'Stopped') {
        issues.push({
          severity: 'warning',
          agentId: agent.agentId,
          message: `Agent ${agent.agentId} status is ${agent.status}`,
        });
      }

      // MCP connection errors
      for (const [service, status] of Object.entries(agent.mcpConnections)) {
        if (status !== 'connected') {
          issues.push({
            severity: 'warning',
            agentId: agent.agentId,
            message: `Agent ${agent.agentId} MCP service ${service} is ${status}`,
          });
        }
      }

      // Idle for too long (30+ minutes)
      if (agent.listeningAt) {
        const idleTime = new Date().getTime() - agent.lastActivityAt.getTime();
        if (idleTime > 30 * 60 * 1000 && agent.agentType === 'head') {
          issues.push({
            severity: 'warning',
            agentId: agent.agentId,
            message: `Agent ${agent.agentId} has been idle for ${Math.round(idleTime / 1000 / 60)} minutes`,
          });
        }
      }
    }

    return issues;
  }
}

/**
 * System-wide health report
 */
export interface HealthReport {
  timestamp: Date;
  uptime: number; // milliseconds
  totalAgents: number;
  healthyAgents: number;
  totalErrors: number;
  agents: AgentRuntimeStatus[];
  issues: HealthIssue[];
}

/**
 * A detected health issue
 */
export interface HealthIssue {
  severity: 'warning' | 'error';
  agentId: string;
  message: string;
}
