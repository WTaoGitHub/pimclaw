/**
 * Supervisor — monitors sub-agent health and performs recovery actions.
 */

import type { AgentRegistryEntry, AgentRole } from "../types/agents.js";
import type { Orchestrator } from "./orchestrator.js";

export type SupervisorReport = {
  timestamp: number;
  totalAgents: number;
  healthy: number;
  errored: number;
  idle: number;
  issues: SupervisorIssue[];
};

export type SupervisorIssue = {
  agentId: string;
  agentName: string;
  severity: "warning" | "error";
  message: string;
};

const IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const ERROR_RATE_THRESHOLD = 0.5; // 50% error rate

export class Supervisor {
  constructor(private readonly orchestrator: Orchestrator) {}

  /**
   * Generate a health report for all registered agents.
   */
  report(): SupervisorReport {
    const agents = this.orchestrator.listAgents();
    const now = Date.now();
    const issues: SupervisorIssue[] = [];

    let healthy = 0;
    let errored = 0;
    let idle = 0;

    for (const agent of agents) {
      const { state, definition } = agent;

      if (state.status === "error") {
        errored++;
        issues.push({
          agentId: definition.id,
          agentName: definition.name,
          severity: "error",
          message: `Agent in error state: ${state.lastError ?? "unknown error"}`,
        });
      } else if (state.status === "idle") {
        idle++;
        healthy++;
      } else {
        healthy++;
      }

      // Check error rate
      if (state.taskCount > 5) {
        const errorRate = state.errorCount / state.taskCount;
        if (errorRate >= ERROR_RATE_THRESHOLD) {
          issues.push({
            agentId: definition.id,
            agentName: definition.name,
            severity: "warning",
            message: `High error rate: ${(errorRate * 100).toFixed(1)}% (${state.errorCount}/${state.taskCount})`,
          });
        }
      }

      // Check idle time
      if (state.status === "idle" && now - state.lastActivity > IDLE_THRESHOLD_MS) {
        issues.push({
          agentId: definition.id,
          agentName: definition.name,
          severity: "warning",
          message: `Agent idle for ${Math.round((now - state.lastActivity) / 60000)} minutes`,
        });
      }
    }

    return {
      timestamp: now,
      totalAgents: agents.length,
      healthy,
      errored,
      idle,
      issues,
    };
  }

  /**
   * Check if a specific agent role is available and healthy.
   */
  isRoleAvailable(role: AgentRole): boolean {
    const agents = this.orchestrator.findAgentsByRole(role);
    return agents.some((a) => a.state.status !== "error" && a.state.status !== "terminated");
  }

  /**
   * Get the healthiest agent for a given role.
   */
  getBestAgentForRole(role: AgentRole): AgentRegistryEntry | undefined {
    const agents = this.orchestrator.findAgentsByRole(role);
    const healthy = agents.filter(
      (a) => a.state.status !== "error" && a.state.status !== "terminated",
    );
    if (healthy.length === 0) return undefined;

    return healthy.reduce((best, curr) => {
      // Prefer lower error count, then more recent activity
      if (curr.state.errorCount < best.state.errorCount) return curr;
      if (
        curr.state.errorCount === best.state.errorCount &&
        curr.state.lastActivity > best.state.lastActivity
      ) return curr;
      return best;
    });
  }
}
