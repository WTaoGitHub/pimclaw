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
export declare class Supervisor {
    private readonly orchestrator;
    constructor(orchestrator: Orchestrator);
    /**
     * Generate a health report for all registered agents.
     */
    report(): SupervisorReport;
    /**
     * Check if a specific agent role is available and healthy.
     */
    isRoleAvailable(role: AgentRole): boolean;
    /**
     * Get the healthiest agent for a given role.
     */
    getBestAgentForRole(role: AgentRole): AgentRegistryEntry | undefined;
}
//# sourceMappingURL=supervisor.d.ts.map