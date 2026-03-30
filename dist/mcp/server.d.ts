/**
 * PimClaw MCP Server — exposes all agent tools via MCP for framework portability.
 * Any MCP-compatible framework (CrewAI, LangGraph, AutoGen, etc.) can consume these.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Orchestrator } from "../master/orchestrator.js";
export type PimClawTool = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<{
        content: Array<{
            type: string;
            text: string;
        }>;
    }>;
};
export declare function buildMasterTools(orchestrator: Orchestrator): PimClawTool[];
export declare function createPimClawMcpServer(orchestrator: Orchestrator): Server;
/**
 * Standalone MCP server entry point.
 * Run: npx tsx src/mcp/server.ts
 */
export declare function servePimClawMcp(): Promise<void>;
//# sourceMappingURL=server.d.ts.map