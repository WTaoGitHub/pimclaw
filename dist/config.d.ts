/**
 * PimClaw configuration types and parser.
 */
import type { McpServiceConfig } from "./types/agents.js";
export type PimClawConfig = {
    perfMcp?: McpServiceConfig;
    monMcp?: McpServiceConfig;
    simMcp?: McpServiceConfig;
    autoCreateAgents?: boolean;
};
export declare function parseConfig(raw: unknown): PimClawConfig;
//# sourceMappingURL=config.d.ts.map