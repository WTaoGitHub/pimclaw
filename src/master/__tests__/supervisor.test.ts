import { describe, it, expect, beforeEach } from "vitest";
import { Supervisor } from "../supervisor.js";
import { Orchestrator } from "../orchestrator.js";

describe("Supervisor", () => {
  let orchestrator: Orchestrator;
  let supervisor: Supervisor;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    supervisor = new Supervisor(orchestrator);
  });

  it("should report empty state", () => {
    const report = supervisor.report();
    expect(report.totalAgents).toBe(0);
    expect(report.healthy).toBe(0);
    expect(report.errored).toBe(0);
    expect(report.issues).toHaveLength(0);
  });

  it("should report healthy agents", async () => {
    await orchestrator.createAgent("perf", "Perf");
    await orchestrator.createAgent("analyst", "Analyst");
    const report = supervisor.report();
    expect(report.totalAgents).toBe(2);
    expect(report.healthy).toBe(2);
    expect(report.idle).toBe(2);
  });

  it("should check role availability", async () => {
    expect(supervisor.isRoleAvailable("perf")).toBe(false);
    await orchestrator.createAgent("perf", "Perf");
    expect(supervisor.isRoleAvailable("perf")).toBe(true);
  });

  it("should select best agent for role", async () => {
    const a1 = await orchestrator.createAgent("perf", "Perf 1");
    const a2 = await orchestrator.createAgent("perf", "Perf 2");
    // Simulate errors on agent 1
    a1.state.taskCount = 10;
    a1.state.errorCount = 5;

    const best = supervisor.getBestAgentForRole("perf");
    expect(best).toBeDefined();
    expect(best!.definition.id).toBe(a2.definition.id);
  });

  it("should flag high error rate agents", async () => {
    const entry = await orchestrator.createAgent("perf", "Perf");
    entry.state.taskCount = 10;
    entry.state.errorCount = 6;

    const report = supervisor.report();
    const warnings = report.issues.filter((i) => i.severity === "warning");
    expect(warnings.some((w) => w.message.includes("error rate"))).toBe(true);
  });
});
