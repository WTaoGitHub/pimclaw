import { describe, it, expect, beforeEach } from "vitest";
import { Router } from "../router.js";
import { Orchestrator } from "../orchestrator.js";

describe("Router", () => {
  let orchestrator: Orchestrator;
  let router: Router;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    router = new Router(orchestrator);
  });

  describe("classifyIntent", () => {
    it("should classify performance data queries as perf", () => {
      expect(router.classifyIntent("What is the throughput of Qwen3-235B?")).toBe("perf");
      expect(router.classifyIntent("Show me benchmark results")).toBe("perf");
      expect(router.classifyIntent("Get performance data for H800")).toBe("perf");
      expect(router.classifyIntent("List all models")).toBe("perf");
      expect(router.classifyIntent("What is the TTFT for chat scenario?")).toBe("perf");
    });

    it("should classify analysis requests as analyst", () => {
      expect(router.classifyIntent("Compare tensor parallel 4 vs 8")).toBe("analyst");
      expect(router.classifyIntent("Recommend the best configuration")).toBe("analyst");
      expect(router.classifyIntent("Analyze the tradeoff between latency and throughput")).toBe("analyst");
      expect(router.classifyIntent("Which config is better for chat?")).toBe("analyst");
    });

    it("should classify monitoring requests as mon", () => {
      expect(router.classifyIntent("Monitor the runtime performance")).toBe("mon");
      expect(router.classifyIntent("Is there a latency spike right now?")).toBe("mon");
      expect(router.classifyIntent("Check current health status")).toBe("mon");
    });

    it("should classify simulation requests as sim", () => {
      expect(router.classifyIntent("Simulate this configuration")).toBe("sim");
      expect(router.classifyIntent("What if we change tensor parallel to 4?")).toBe("sim");
      expect(router.classifyIntent("Predict the performance before deploy")).toBe("sim");
    });

    it("should default to perf for ambiguous queries", () => {
      expect(router.classifyIntent("hello")).toBe("perf");
    });
  });

  describe("route", () => {
    it("should route to existing agent by role", async () => {
      await orchestrator.createAgent("perf", "Perf Agent");
      const result = await router.route("Get throughput data");
      expect(result.role).toBe("perf");
      expect(result.agentId).toMatch(/^perf-/);
    });

    it("should report missing agent", async () => {
      const result = await router.route("Monitor runtime");
      expect(result.role).toBe("mon");
      expect(result.result).toContain("No \"mon\" agent");
    });

    it("should route directly by agent ID", async () => {
      const entry = await orchestrator.createAgent("analyst", "Analyst");
      const result = await router.route("anything", entry.definition.id);
      expect(result.agentId).toBe(entry.definition.id);
      expect(result.role).toBe("analyst");
    });

    it("should report unknown direct agent", async () => {
      const result = await router.route("task", "nonexistent");
      expect(result.result).toContain("not found");
    });
  });
});
