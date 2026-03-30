/**
 * Router — analyzes incoming tasks and routes them to the appropriate sub-agent.
 * Supports direct routing (by agent ID) and intent-based routing (by keyword analysis).
 */

import type { AgentRole } from "../types/agents.js";
import type { Orchestrator } from "./orchestrator.js";

type RouteResult = {
  agentId: string;
  role: string;
  result: string;
};

/** Keyword patterns that indicate which agent role should handle a task. */
const ROLE_PATTERNS: Array<{ role: AgentRole; patterns: RegExp[]; weight: number }> = [
  {
    role: "mon",
    weight: 3,
    patterns: [
      /\bmonitor\b/i,
      /\b(runtime|live|real-?time)\b.*\b(performance|status|health|data)\b/i,
      /\b(current|right now)\b.*\b(status|health|performance)\b/i,
      /\b(alert|spike|anomaly|degradation|down)\b/i,
    ],
  },
  {
    role: "sim",
    weight: 3,
    patterns: [
      /\bsimulat/i,
      /\bwhat.if\b/i,
      /\b(predict|forecast|hypothetical)\b/i,
      /\b(before deploy|test config|try config)\b/i,
    ],
  },
  {
    role: "analyst",
    weight: 2,
    patterns: [
      /\b(analyze|analysis|compare|comparison|recommend|optimal|best|worst)\b/i,
      /\b(tradeoff|trade-off|improve|optimize|bottleneck)\b/i,
      /\b(why|should|better|versus|vs)\b/i,
    ],
  },
  {
    role: "perf",
    weight: 1,
    patterns: [
      /\b(benchmark|throughput|latency|ttft|tpot|qps)\b/i,
      /\b(fetch|query|get|list|show)\b.*\b(data|models?|configs?|results?|metrics?)\b/i,
      /\b(what|which)\b.*\b(models?|devices?|engines?)\b/i,
      /\bhow (fast|slow|many)\b/i,
      /\bperformance\s+(data|history|benchmark|result)/i,
    ],
  },
];

export class Router {
  constructor(private readonly orchestrator: Orchestrator) {}

  /**
   * Determine the best agent role for a given task description.
   */
  classifyIntent(task: string): AgentRole {
    let bestRole: AgentRole = "perf"; // default
    let bestScore = 0;

    for (const { role, patterns, weight } of ROLE_PATTERNS) {
      let score = 0;
      for (const pattern of patterns) {
        if (pattern.test(task)) score += weight;
      }
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }

    return bestRole;
  }

  /**
   * Route a task to the most appropriate agent.
   * If targetAgentId is provided, routes directly to that agent.
   * Otherwise, classifies intent and finds (or reports missing) the right agent.
   */
  async route(task: string, targetAgentId?: string): Promise<RouteResult> {
    // Direct routing
    if (targetAgentId) {
      const agent = this.orchestrator.getAgent(targetAgentId);
      if (!agent) {
        return {
          agentId: targetAgentId,
          role: "unknown",
          result: `Agent "${targetAgentId}" not found. Use pimclaw_list_agents to see available agents, or pimclaw_create_agent to create one.`,
        };
      }
      return {
        agentId: agent.definition.id,
        role: agent.definition.role,
        result: `Task routed to ${agent.definition.name} (${agent.definition.role}): "${task}"`,
      };
    }

    // Intent-based routing
    const role = this.classifyIntent(task);
    const agents = this.orchestrator.findAgentsByRole(role);

    if (agents.length === 0) {
      return {
        agentId: "",
        role,
        result: `No "${role}" agent is currently running. Create one with pimclaw_create_agent (role: "${role}") and configure its MCP service connection.`,
      };
    }

    // Pick the agent with the least errors and most recent activity
    const best = agents.reduce((a, b) => {
      if (a.state.errorCount !== b.state.errorCount) {
        return a.state.errorCount < b.state.errorCount ? a : b;
      }
      return a.state.lastActivity > b.state.lastActivity ? a : b;
    });

    return {
      agentId: best.definition.id,
      role: best.definition.role,
      result: `Task routed to ${best.definition.name} (${best.definition.role}): "${task}". Use pimclaw_call_mcp_tool or pimclaw_list_agent_tools to interact with this agent's MCP services.`,
    };
  }
}
