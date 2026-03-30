import { describe, it, expect, beforeEach } from "vitest";
import { Orchestrator } from "../orchestrator.js";

describe("Orchestrator", () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator();
  });

  it("should create an agent", async () => {
    const entry = await orchestrator.createAgent("perf", "Test Perf Agent");
    expect(entry.definition.role).toBe("perf");
    expect(entry.definition.name).toBe("Test Perf Agent");
    expect(entry.state.status).toBe("idle");
    expect(entry.definition.id).toMatch(/^perf-/);
  });

  it("should list agents", async () => {
    await orchestrator.createAgent("perf", "Perf");
    await orchestrator.createAgent("analyst", "Analyst");
    const agents = orchestrator.listAgents();
    expect(agents).toHaveLength(2);
  });

  it("should find agents by role", async () => {
    await orchestrator.createAgent("perf", "Perf 1");
    await orchestrator.createAgent("perf", "Perf 2");
    await orchestrator.createAgent("analyst", "Analyst");
    expect(orchestrator.findAgentsByRole("perf")).toHaveLength(2);
    expect(orchestrator.findAgentsByRole("analyst")).toHaveLength(1);
    expect(orchestrator.findAgentsByRole("mon")).toHaveLength(0);
  });

  it("should terminate an agent", async () => {
    const entry = await orchestrator.createAgent("perf", "Perf");
    expect(orchestrator.listAgents()).toHaveLength(1);
    const ok = await orchestrator.terminateAgent(entry.definition.id);
    expect(ok).toBe(true);
    expect(orchestrator.listAgents()).toHaveLength(0);
  });

  it("should return false for terminating unknown agent", async () => {
    const ok = await orchestrator.terminateAgent("nonexistent");
    expect(ok).toBe(false);
  });

  it("should get agent by id", async () => {
    const entry = await orchestrator.createAgent("analyst", "Analyst");
    const found = orchestrator.getAgent(entry.definition.id);
    expect(found).toBeDefined();
    expect(found!.definition.name).toBe("Analyst");
  });

  it("should return undefined for unknown agent", () => {
    expect(orchestrator.getAgent("nonexistent")).toBeUndefined();
  });

  it("should shutdown all agents", async () => {
    await orchestrator.createAgent("perf", "Perf");
    await orchestrator.createAgent("analyst", "Analyst");
    await orchestrator.createAgent("mon", "Mon");
    expect(orchestrator.listAgents()).toHaveLength(3);
    await orchestrator.shutdown();
    expect(orchestrator.listAgents()).toHaveLength(0);
  });

  it("should assign system prompts by role", async () => {
    const perf = await orchestrator.createAgent("perf", "P");
    const analyst = await orchestrator.createAgent("analyst", "A");
    expect(perf.definition.systemPrompt).toContain("Performance Data Agent");
    expect(analyst.definition.systemPrompt).toContain("Performance Analyst Agent");
  });

  it("should accept custom prompts", async () => {
    const entry = await orchestrator.createAgent("custom", "Custom", {}, "Do custom things");
    expect(entry.definition.systemPrompt).toBe("Do custom things");
  });
});
