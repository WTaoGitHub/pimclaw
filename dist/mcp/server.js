/**
 * PimClaw MCP Server — exposes all agent tools via MCP for framework portability.
 * Any MCP-compatible framework (CrewAI, LangGraph, AutoGen, etc.) can consume these.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
export function buildMasterTools(orchestrator) {
    return [
        {
            name: "pimclaw_list_agents",
            description: "List all registered sub-agents with their status",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({
                content: [{ type: "text", text: JSON.stringify(orchestrator.listAgents(), null, 2) }],
            }),
        },
        {
            name: "pimclaw_create_agent",
            description: "Create a new sub-agent with a specific role. Roles: perf (performance data fetcher), analyst (data analysis), mon (runtime monitor), sim (simulation)",
            inputSchema: {
                type: "object",
                properties: {
                    role: { type: "string", enum: ["perf", "analyst", "mon", "sim"] },
                    name: { type: "string", description: "Display name for the agent" },
                    mcpServices: {
                        type: "object",
                        description: "Map of MCP service name to config {command, args, env}",
                        additionalProperties: {
                            type: "object",
                            properties: {
                                command: { type: "string" },
                                args: { type: "array", items: { type: "string" } },
                                env: { type: "object", additionalProperties: { type: "string" } },
                            },
                            required: ["command", "args"],
                        },
                    },
                },
                required: ["role", "name"],
            },
            execute: async (args) => {
                const entry = await orchestrator.createAgent(args.role, args.name, args.mcpServices ?? {});
                return {
                    content: [{ type: "text", text: `Agent "${entry.definition.name}" (${entry.definition.id}) created with role "${entry.definition.role}"` }],
                };
            },
        },
        {
            name: "pimclaw_terminate_agent",
            description: "Terminate a sub-agent by ID",
            inputSchema: {
                type: "object",
                properties: { agentId: { type: "string" } },
                required: ["agentId"],
            },
            execute: async (args) => {
                const ok = await orchestrator.terminateAgent(args.agentId);
                return {
                    content: [{ type: "text", text: ok ? `Agent ${args.agentId} terminated` : `Agent ${args.agentId} not found` }],
                };
            },
        },
        {
            name: "pimclaw_agent_status",
            description: "Get detailed status of a specific sub-agent",
            inputSchema: {
                type: "object",
                properties: { agentId: { type: "string" } },
                required: ["agentId"],
            },
            execute: async (args) => {
                const entry = orchestrator.getAgent(args.agentId);
                if (!entry) {
                    return { content: [{ type: "text", text: `Agent ${args.agentId} not found` }] };
                }
                return {
                    content: [{ type: "text", text: JSON.stringify(entry, null, 2) }],
                };
            },
        },
        {
            name: "pimclaw_route_task",
            description: "Route a task to the appropriate sub-agent. The master agent analyzes the request and delegates to the best agent.",
            inputSchema: {
                type: "object",
                properties: {
                    task: { type: "string", description: "The task description" },
                    targetAgentId: { type: "string", description: "Optional: specific agent ID to route to" },
                },
                required: ["task"],
            },
            execute: async (args) => {
                const result = await orchestrator.routeTask(args.task, args.targetAgentId);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            },
        },
        {
            name: "pimclaw_call_mcp_tool",
            description: "Call a tool on a sub-agent's connected MCP service directly. Use pimclaw_list_agent_tools to discover available tools first.",
            inputSchema: {
                type: "object",
                properties: {
                    agentId: { type: "string" },
                    serviceName: { type: "string" },
                    toolName: { type: "string" },
                    args: { type: "object", additionalProperties: true },
                },
                required: ["agentId", "serviceName", "toolName"],
            },
            execute: async (args) => {
                const result = await orchestrator.callAgentMcpTool(args.agentId, args.serviceName, args.toolName, args.args ?? {});
                return { content: result.content };
            },
        },
        {
            name: "pimclaw_list_agent_tools",
            description: "List all MCP tools available to a specific sub-agent from its connected services",
            inputSchema: {
                type: "object",
                properties: { agentId: { type: "string" } },
                required: ["agentId"],
            },
            execute: async (args) => {
                const tools = await orchestrator.listAgentTools(args.agentId);
                return {
                    content: [{ type: "text", text: JSON.stringify(tools, null, 2) }],
                };
            },
        },
    ];
}
export function createPimClawMcpServer(orchestrator) {
    const tools = buildMasterTools(orchestrator);
    const toolMap = new Map();
    for (const tool of tools) {
        toolMap.set(tool.name, tool);
    }
    const server = new Server({ name: "pimclaw", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = toolMap.get(request.params.name);
        if (!tool) {
            return {
                content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
                isError: true,
            };
        }
        try {
            return await tool.execute(request.params.arguments ?? {});
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    });
    return server;
}
/**
 * Standalone MCP server entry point.
 * Run: npx tsx src/mcp/server.ts
 */
export async function servePimClawMcp() {
    const { Orchestrator } = await import("../master/orchestrator.js");
    const orchestrator = new Orchestrator();
    const server = createPimClawMcpServer(orchestrator);
    const transport = new StdioServerTransport();
    const shutdown = () => {
        void orchestrator.shutdown();
        void server.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdin.once("end", shutdown);
    await server.connect(transport);
}
// Run directly if executed as main module
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
    servePimClawMcp().catch((err) => {
        process.stderr.write(`pimclaw mcp server error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map