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
export declare class Router {
    private readonly orchestrator;
    constructor(orchestrator: Orchestrator);
    /**
     * Determine the best agent role for a given task description.
     */
    classifyIntent(task: string): AgentRole;
    /**
     * Route a task to the most appropriate agent.
     * If targetAgentId is provided, routes directly to that agent.
     * Otherwise, classifies intent and finds (or reports missing) the right agent.
     */
    route(task: string, targetAgentId?: string): Promise<RouteResult>;
}
export {};
//# sourceMappingURL=router.d.ts.map