/**
 * PimClaw - LLM Deployment Orchestration System
 *
 * When used as an OpenClaw plugin the default export from
 * ./openclaw-plugin.ts is the entry point — it registers a background
 * service that boots all agents and exposes tools to OpenClaw.
 *
 * This file re-exports the building blocks for standalone use or
 * advanced composition.
 */

// ── OpenClaw plugin entry (default export) ─────────────────────────────────
export { default } from './openclaw-plugin.js';

// ── Core orchestration components ──────────────────────────────────────────
export { AgentRegistry } from './master/agent-registry.js';
export type { HealthReport, HealthIssue } from './master/agent-registry.js';
export { TaskStatusRecorder } from './master/task-status-recorder.js';
export { BaseAgent } from './master/base-agent.js';
export { SchedulerAgent } from './master/scheduler-agent.js';
export { HeadAgent } from './master/head-agent.js';
export { WorkerAgent } from './master/worker-agent.js';

// ── MCP integration ───────────────────────────────────────────────────────
export { PimClawMCPServer } from './master/mcp-server.js';

// ── Configuration ─────────────────────────────────────────────────────────
export { ConfigurationManager } from './config-manager.js';
export type { PimClawConfig } from './config-manager.js';

// ── Types ─────────────────────────────────────────────────────────────────
export * from './types/index.js';
export * from './types/agents.js';
export * from './types/tasks.js';
export * from './types/models.js';
