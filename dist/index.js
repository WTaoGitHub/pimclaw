/**
 * PimClaw — OpenClaw Plugin Entry Point
 *
 * Pagoda Inference Model Claw: A multi-agent system for managing
 * LLM inference model deployments. Creates, supervises, and coordinates
 * specialized sub-agents that consume external MCP services (perf, mon, sim).
 */
import { definePluginEntry, } from "openclaw/plugin-sdk/plugin-entry";
import { Orchestrator } from "./master/orchestrator.js";
import { Supervisor } from "./master/supervisor.js";
import { buildMasterTools } from "./mcp/server.js";
import { parseConfig } from "./config.js";
// Singleton orchestrator — shared between plugin tools and MCP server
let sharedOrchestrator = null;
export function getOrchestrator() {
    if (!sharedOrchestrator) {
        sharedOrchestrator = new Orchestrator();
    }
    return sharedOrchestrator;
}
/**
 * Auto-create default agents based on plugin configuration.
 */
async function autoCreateAgents(orchestrator, config, log) {
    if (config.perfMcp) {
        try {
            await orchestrator.createAgent("perf", "Performance Data Agent", { perf: config.perfMcp });
            log.info("pimclaw: auto-created perf agent");
        }
        catch (err) {
            log.error(`pimclaw: failed to auto-create perf agent: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // Always create analyst (no MCP dependency — it analyzes data from perf agent)
    try {
        await orchestrator.createAgent("analyst", "Performance Analyst Agent");
        log.info("pimclaw: auto-created analyst agent");
    }
    catch (err) {
        log.error(`pimclaw: failed to auto-create analyst agent: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (config.monMcp) {
        try {
            await orchestrator.createAgent("mon", "Runtime Monitor Agent", { mon: config.monMcp });
            log.info("pimclaw: auto-created mon agent");
        }
        catch (err) {
            log.error(`pimclaw: failed to auto-create mon agent: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (config.simMcp) {
        try {
            await orchestrator.createAgent("sim", "Simulation Agent", { sim: config.simMcp });
            log.info("pimclaw: auto-created sim agent");
        }
        catch (err) {
            log.error(`pimclaw: failed to auto-create sim agent: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
/**
 * PimClaw OpenClaw plugin definition.
 */
export default definePluginEntry({
    id: "pimclaw",
    name: "PimClaw",
    description: "Pagoda Inference Model Claw — Multi-agent system for LLM inference model performance management",
    register(api) {
        const config = parseConfig(api.pluginConfig);
        const orchestrator = getOrchestrator();
        const supervisor = new Supervisor(orchestrator);
        api.logger.info("pimclaw: plugin registered");
        // Register all master agent tools as AnyAgentTool objects
        const masterTools = buildMasterTools(orchestrator);
        for (const tool of masterTools) {
            api.registerTool({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                execute: async (_toolCallId, rawParams) => {
                    return tool.execute(rawParams);
                },
            });
        }
        // Register supervisor health check tool
        api.registerTool({
            name: "pimclaw_health",
            description: "Get a health report for all PimClaw sub-agents",
            parameters: { type: "object", properties: {} },
            execute: async () => ({
                content: [{ type: "text", text: JSON.stringify(supervisor.report(), null, 2) }],
            }),
        });
        // Register the orchestrator as a service for lifecycle management
        api.registerService({
            id: "pimclaw",
            start: async () => {
                if (config.autoCreateAgents !== false) {
                    await autoCreateAgents(orchestrator, config, api.logger);
                }
                api.logger.info("pimclaw: service started");
            },
            stop: async () => {
                await orchestrator.shutdown();
                sharedOrchestrator = null;
                api.logger.info("pimclaw: service stopped");
            },
        });
    },
});
export { Orchestrator } from "./master/orchestrator.js";
export { Router } from "./master/router.js";
export { Supervisor } from "./master/supervisor.js";
export { createPimClawMcpServer, servePimClawMcp } from "./mcp/server.js";
//# sourceMappingURL=index.js.map