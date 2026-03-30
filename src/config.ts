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

export function parseConfig(raw: unknown): PimClawConfig {
  if (!raw || typeof raw !== "object") return { autoCreateAgents: true };

  const obj = raw as Record<string, unknown>;
  const config: PimClawConfig = {
    autoCreateAgents: obj.autoCreateAgents !== false,
  };

  if (obj.perfMcp && typeof obj.perfMcp === "object") {
    const p = obj.perfMcp as Record<string, unknown>;
    if (typeof p.command === "string" && Array.isArray(p.args)) {
      config.perfMcp = {
        command: p.command,
        args: p.args as string[],
        env: (p.env as Record<string, string>) ?? undefined,
      };
    }
  }

  if (obj.monMcp && typeof obj.monMcp === "object") {
    const m = obj.monMcp as Record<string, unknown>;
    if (typeof m.command === "string" && Array.isArray(m.args)) {
      config.monMcp = {
        command: m.command,
        args: m.args as string[],
        env: (m.env as Record<string, string>) ?? undefined,
      };
    }
  }

  if (obj.simMcp && typeof obj.simMcp === "object") {
    const s = obj.simMcp as Record<string, unknown>;
    if (typeof s.command === "string" && Array.isArray(s.args)) {
      config.simMcp = {
        command: s.command,
        args: s.args as string[],
        env: (s.env as Record<string, string>) ?? undefined,
      };
    }
  }

  return config;
}
