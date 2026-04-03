/**
 * PimClaw - LLM Deployment Orchestration System (v2 Hybrid Architecture)
 *
 * When used as an OpenClaw plugin the default export from
 * ./openclaw-plugin.ts is the entry point — it registers a background
 * service that boots PimClaw components and exposes tools to OpenClaw agents.
 *
 * LLM Head and Planner agents run externally via OpenClaw's agent runtime.
 * See AGENTS.md for their definitions.
 */

// ── OpenClaw plugin entry (default export) ─────────────────────────────────
export { default } from './openclaw-plugin.js';
export { registerToolHook } from './openclaw-plugin.js';
export type { ToolHook } from './openclaw-plugin.js';

// ── Core orchestration components ──────────────────────────────────────────
export { ComponentRegistry } from './master/component-registry.js';
/** @deprecated Use ComponentRegistry instead */
export { ComponentRegistry as AgentRegistry } from './master/component-registry.js';
export type { HealthReport, HealthIssue } from './master/component-registry.js';
export { TaskStatusRecorder } from './master/task-status-recorder.js';
export { BaseAgent } from './master/base-agent.js';
export type { LifecyclePhase } from './master/base-agent.js';
export { SchedulerAgent } from './master/scheduler-agent.js';
export { WorkerAgent } from './master/worker-agent.js';

// ── Integration boundary ──────────────────────────────────────────────────
export { AnomalyReceiver } from './master/anomaly-receiver.js';
export type { AnomalyEvent, ValidatedEvent, AnomalyReceiverConfig, HookResult } from './master/anomaly-receiver.js';
export { PlannerTrigger } from './master/planner-trigger.js';
export type { OpenClawAgentApi, PlannerTriggerConfig } from './master/planner-trigger.js';

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
