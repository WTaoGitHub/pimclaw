import { describe, it, expect } from "vitest";
import { buildMasterTools } from "../../mcp/server.js";
import { Orchestrator } from "../../master/orchestrator.js";

describe("MCP Server Tools", () => {
  it("should expose all master tools", () => {
    const orchestrator = new Orchestrator();
    const tools = buildMasterTools(orchestrator);

    const names = tools.map((t) => t.name);
    expect(names).toContain("pimclaw_list_agents");
    expect(names).toContain("pimclaw_create_agent");
    expect(names).toContain("pimclaw_terminate_agent");
    expect(names).toContain("pimclaw_agent_status");
    expect(names).toContain("pimclaw_route_task");
    expect(names).toContain("pimclaw_call_mcp_tool");
    expect(names).toContain("pimclaw_list_agent_tools");
  });

  it("should list agents through tool", async () => {
    const orchestrator = new Orchestrator();
    await orchestrator.createAgent("perf", "Test Perf");
    const tools = buildMasterTools(orchestrator);
    const listTool = tools.find((t) => t.name === "pimclaw_list_agents")!;

    const result = await listTool.execute({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].definition.name).toBe("Test Perf");
  });

  it("should create agent through tool", async () => {
    const orchestrator = new Orchestrator();
    const tools = buildMasterTools(orchestrator);
    const createTool = tools.find((t) => t.name === "pimclaw_create_agent")!;

    const result = await createTool.execute({ role: "analyst", name: "My Analyst" });
    expect(result.content[0].text).toContain("My Analyst");
    expect(orchestrator.listAgents()).toHaveLength(1);
  });

  it("should terminate agent through tool", async () => {
    const orchestrator = new Orchestrator();
    const entry = await orchestrator.createAgent("perf", "P");
    const tools = buildMasterTools(orchestrator);
    const terminateTool = tools.find((t) => t.name === "pimclaw_terminate_agent")!;

    const result = await terminateTool.execute({ agentId: entry.definition.id });
    expect(result.content[0].text).toContain("terminated");
    expect(orchestrator.listAgents()).toHaveLength(0);
  });

  it("should route task through tool", async () => {
    const orchestrator = new Orchestrator();
    await orchestrator.createAgent("perf", "Perf Agent");
    const tools = buildMasterTools(orchestrator);
    const routeTool = tools.find((t) => t.name === "pimclaw_route_task")!;

    const result = await routeTool.execute({ task: "Get throughput data" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.role).toBe("perf");
  });
});
