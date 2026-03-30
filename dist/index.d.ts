/**
 * PimClaw — OpenClaw Plugin Entry Point
 *
 * Pagoda Inference Model Claw: A multi-agent system for managing
 * LLM inference model deployments. Creates, supervises, and coordinates
 * specialized sub-agents that consume external MCP services (perf, mon, sim).
 */
import { Orchestrator } from "./master/orchestrator.js";
export declare function getOrchestrator(): Orchestrator;
/**
 * PimClaw OpenClaw plugin definition.
 */
declare const _default: import("openclaw/plugin-sdk/plugin-entry").DefinedPluginEntry;
export default _default;
export { Orchestrator } from "./master/orchestrator.js";
export { Router } from "./master/router.js";
export { Supervisor } from "./master/supervisor.js";
export { createPimClawMcpServer, servePimClawMcp } from "./mcp/server.js";
export type { PimClawConfig } from "./config.js";
//# sourceMappingURL=index.d.ts.map