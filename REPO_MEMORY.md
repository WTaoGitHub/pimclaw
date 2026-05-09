# PimClaw Repo Memory

Last updated: 2026-05-09

## What This Repo Is

PimClaw is an OpenClaw plugin for autonomous LLM deployment orchestration.
It monitors LLM inference services via Prometheus, detects anomalies through
an external LLM Head agent, plans configuration changes through an external
LLM Planner agent, and executes those changes via an Engine MCP (qianjin-xuntui).

The current architecture is **v2 hybrid**:
- **External LLM agents** (run via OpenClaw's agent runtime on cron/on-demand):
  - `pimclaw-head` — 5-minute cron, queries Prometheus, detects anomalies, submits feedback
  - `pimclaw-planner` — on-demand, receives anomaly events, queries Perf/Sim MCPs, submits config plans
- **Plugin-internal components** (run inside the OpenClaw process):
  - `AnomalyReceiver` — validates/deduplicates anomaly events, groups by deployment, triggers Planner
  - `PlannerTrigger` — spawns Planner agent via OpenClaw API or CLI fallback
  - `TaskStatusRecorder` — task persistence (JSON file), state machine, status waiters
  - `SchedulerAgent` — polls for ready tasks, spawns ephemeral WorkerAgents
  - `WorkerAgent` — executes one task via TaskExecutor → EngineMcpClient
  - `TaskExecutor` — maps task types (scale-up/down/restart/reconfigure) to Engine MCP tool calls
  - `ComponentRegistry` — live tracking of all component runtime status + health reports
  - `PrometheusClient` — HTTP client for Prometheus query/query_range
  - `MetricsStore` — ring-buffer persistence of metric snapshots
  - `HeadSummaryStore` — persists last 10 monitoring-cycle summaries in Head workspace
  - `PlannerMemoryStore` — episode/lesson persistence for planner learning loops
  - `EngineMcpClient` — SSE transport to qianjin-xuntui MCP (auth lifecycle: login → token → tenant)
  - `PerfMcpClient` — stdio transport to perfllm Python MCP server (PostgreSQL-backed)
  - `SimMcpClient` — SSE transport to Hisim simulation MCP server
  - `FileLogger` — rotating file-based logger wrapping OpenClaw's PluginLogger

## Architecture Overview

```
Prometheus ──(HTTP)──► pimclaw_query_metrics ◄──(5m cron)── pimclaw-head (LLM)
                              │                               │
                              │                      pimclaw_submit_anomalies
                              │                      pimclaw_submit_task_feedback
                              ▼                               │
                       AnomalyReceiver ──(groups by deployment)──► PlannerTrigger
                                                            │
                                            pimclaw-planner (LLM, one-shot)
                                            (gets Perf MCP + Sim MCP + memory context)
                                                            │
                                                  pimclaw_plan_task
                                                            │
                                                            ▼
                     TaskStatusRecorder ◄──(planning→ready)──┘
                            │
                     SchedulerAgent (polls ready tasks)
                            │
                     WorkerAgent (one per task)
                            │
                     TaskExecutor ──(MCP)──► EngineMcpClient ──► qianjin-xuntui
```

## Data Flow

1. **Head agent** calls `pimclaw_query_metrics` → plugin queries Prometheus → returns grouped metrics
2. **Head agent** calls `pimclaw_submit_anomalies` → AnomalyReceiver validates, deduplicates, groups by deployment → creates tasks → triggers Planner per deployment group
3. **Planner agent** calls `pimclaw_query_perfllm`, `pimclaw_sim_*` tools → selects optimal config → calls `pimclaw_plan_task`
4. **Plugin** transitions task `planning→ready`, Scheduler picks it up, Worker executes via Engine MCP
5. **Head agent** later calls `pimclaw_submit_task_feedback` with follow-up review within validity window

## Task Lifecycle

```
planning → ready → scheduling → scheduled → running → done/failed/expired
                ↘ expired                                              ↗
                                                                 ↘ retry (back to ready)
```

Fallback: if Planner times out, `applyFallbackPlan()` applies a default task type/config.

## Tool Inventory (21 tools)

Registered via `openclaw.plugin.json` contracts and built in `buildPimClawTools()`:

| Tool | Purpose | Caller |
|------|---------|--------|
| `pimclaw_query_metrics` | Prometheus queries, grouped by engine | Head |
| `pimclaw_submit_anomalies` | Submit anomaly events | Head |
| `pimclaw_submit_task_feedback` | Submit follow-up feedback for completed tasks | Head |
| `pimclaw_plan_task` | Submit deployment config plan | Planner |
| `pimclaw_route_task` | Direct task submission (bypasses Head/Planner) | Operator |
| `pimclaw_list_components` | List all component runtime status | Operator |
| `pimclaw_component_status` | Single component status | Operator |
| `pimclaw_health` | System health report | Operator |
| `pimclaw_task_counts` | Task counts by status | Head/Operator |
| `pimclaw_list_tasks` | List tasks with optional status filter | Head/Planner/Operator |
| `pimclaw_retry_task` | Reset failed task for retry | Operator |
| `pimclaw_revoke_task` | Cancel task (mark expired) | Operator |
| `pimclaw_query_perfllm` | Query perfllm historical benchmark data | Planner |
| `pimclaw_get_perfllm_schema` | Get perfllm table schema | Planner |
| `pimclaw_sim_register_hardware` | Register hardware for simulation | Planner |
| `pimclaw_sim_list_hardware` | List registered hardware | Planner |
| `pimclaw_sim_start` | Start SGLang simulation server | Planner |
| `pimclaw_sim_stop` | Stop simulation server | Planner |
| `pimclaw_sim_status` | Get simulation server status | Planner |
| `pimclaw_sim_benchmark` | Run benchmark against simulation | Planner |
| `pimclaw_sim_dataset_info` | Preview dataset info | Planner |

## Plugin Configuration Schema

From `openclaw.plugin.json` configSchema:

- `prometheus.baseUrl` (required) — Prometheus endpoint. Inside the `openclaw-latest` container, use `http://host.docker.internal:29001/`
- `prometheus.engine` — `"vllm"` | `"sglang"` | array, default: all engines
- `prometheus.queryOverrides` — override PromQL per metric
- `prometheus.defaultLabels` — extra label matchers
- `engineMcp.sseUrl`, `.username`, `.password` (required) — qianjin-xuntui Engine MCP
- `engineMcp.tenantId` — optional tenant filter
- `perfMcp.serverScriptPath` (required) — path to perfllm_mcp_server.py
- `perfMcp.pythonPath` — default `python3.12`
- `perfMcp.env` — extra env vars (e.g. `PERF_DB_HOST=host.docker.internal`)
- `simMcp.sseUrl` (required) — Hisim simulation MCP endpoint
- `planner.agentId` — default `pimclaw-planner`
- `planner.timeoutSeconds` — default 600
- `planner.workspaceDir` — default `.pimclaw-agents/planner`
- `planner.fallbackTaskType` — default `scale-up`
- `planner.fallbackConfig` — default `{ replicaDelta: 1 }`
- `anomalyReceiver.maxEventsPerSubmission` — default 20
- `anomalyReceiver.deduplicationWindowMs` — default 600000 (10 min)
- `anomalyReceiver.planningTimeoutMs` — default 600000 (10 min)
- `headFeedback.settlingDelayMs` — default 900000 (15 min)
- `headFeedback.feedbackValidityMs` — default 3600000 (1 hour)

## Files To Treat As Live

### Core Plugin
- `src/openclaw-plugin.ts` — main plugin entry (2204 lines), v2 hybrid architecture, all tool definitions
- `src/master/anomaly-receiver.ts` — validates events, groups by deployment, triggers Planner
- `src/master/planner-trigger.ts` — spawns Planner via OpenClaw API, manages fallback
- `src/master/planner-launch.ts` — selects between native API and CLI fallback for planner
- `src/master/task-status-recorder.ts` — task persistence, state machine, status waiters
- `src/master/scheduler-agent.ts` — polls ready tasks, spawns Workers, concurrency limits
- `src/master/worker-agent.ts` — ephemeral per-task execution, retry/timeout handling
- `src/master/task-executor.ts` — maps task types to Engine MCP tool call sequences
- `src/master/component-registry.ts` — live tracking of all component runtime status
- `src/master/base-agent.ts` — abstract base for Scheduler/Worker with lifecycle + MCP client
- `src/master/prometheus-client.ts` — Prometheus HTTP client + vLLM/SGLang PromQL maps + injectLabels
- `src/master/metrics-store.ts` — ring-buffer metric persistence
- `src/master/head-summary-store.ts` — Head monitoring summary persistence (last 10 records)
- `src/master/head-task-feedback.ts` — Head follow-up feedback review window logic
- `src/master/planner-memory-store.ts` — planner learning episode/lesson persistence
- `src/master/engine-mcp-client.ts` — SSE MCP client for qianjin-xuntui with auth lifecycle
- `src/master/perf-mcp-client.ts` — Stdio MCP client for perfllm Python server
- `src/master/sim-mcp-client.ts` — SSE MCP client for Hisim simulation server
- `src/master/file-logger.ts` — rotating file-based logger

### Types
- `src/types/index.ts` — re-exports from agents, models, planner-memory, tasks
- `src/types/tasks.ts` — Task, TaskStatus, TaskFeedback, MetricsSnapshot, DetectedEvent
- `src/types/planner-memory.ts` — PlannerMemoryEpisode, Lesson, Index types
- `src/types/agents.ts` — AgentRuntimeStatus, AgentType, AgentStatus types
- `src/types/models.ts` — model-related types

### Agent Instructions
- `AGENTS.md` — root agent instructions (Head + Planner system prompts)
- `agents/pimclaw-head/AGENTS.md` — Head agent workspace doc
- `agents/pimclaw-planner/AGENTS.md` — Planner agent workspace doc
- `agents/pimclaw-main/AGENTS.md` — Main agent workspace doc

### Configuration / Deployment
- `openclaw.plugin.json` — plugin manifest with configSchema + tool contracts
- `package.json` — project metadata, scripts, openclaw compat
- `cicd/openclaw.json` — live OpenClaw config (⚠️ contains credentials)
- `cicd/pimclaw-delopyment-template-persistent.yaml` — K8s deployment template
- `cicd/deploy.sh` — deployment script
- `Dockerfile.openclaw-latest` — container build (includes offline Python wheels)
- `cicd/wheels/` — pre-downloaded Python wheels for offline Docker build

### Tests
- `src/__tests__/full-pipeline-e2e.test.ts` — full pipeline E2E test
- `src/__tests__/openclaw-plugin-feedback.e2e.test.ts` — Head feedback flow E2E
- `src/__tests__/openclaw-plugin-plan-task.e2e.test.ts` — Planner submission E2E
- `src/master/__tests__/` — unit tests per component (18 files)

## Stale Or Legacy (Do Not Trust For Current Architecture)

- `src/master/head-agent.ts` — **legacy**. Contains mock metrics, snapshot-based observation loop, placeholder MCP paths. The real Head agent is external (LLM-based, runs on cron via OpenClaw agent runtime). This file is NOT used in production.
- `src/master/agent-registry.ts` — **duplicate** of `component-registry.ts` with the same `ComponentRegistry` class. The import path `./component-registry.js` is canonical. This file is dead code.
- `src/master/mcp-server.ts` — **standalone MCP server** that predates the OpenClaw plugin integration. Not used in the plugin path. The plugin registers tools via `api.registerTool()` instead.
- `src/config-manager.ts` — YAML-based config system. The plugin uses `openclaw.plugin.json` configSchema instead. May be leftover from v1.
- `src/master/cli.ts` — CLI entry point, likely from v1 standalone mode.
- `docs/design/my_design/design.md` — original v1 design doc (marked "never change this file")
- `docs/design/opus/` — contains older design iterations (`pimclaw-as-openclaw-agents.md`, `pimclaw-as-openclaw-agents-v2.md`, `architecture.md`). Useful for context only.
- `fake-promethues-server/` — test helper, not production code
- `SKILL/` — skill definitions, not core logic
- `prompts/` — prompt templates, may be stale

## Git History Guidance

### Timeline (47 commits, 2026-03-30 → 2026-04-28)

**Phase 1: Init & Design** (Mar 30 – Apr 2)
- `1fa759b` init
- `5a26c39` write docs
- `588238e` requirement and design development
- `b24abe9` new design completed
- `a4f64ea` rewrite: multi-agent orchestration with OpenClaw plugin integration
- `ffa78a0` testing doc

**Phase 2: v2 Design & v3 Implementation** (Apr 2 – Apr 14)
- `98c9f98` pimclaw design v2
- `4ddd8f9` pimclaw agents design v2, update 1
- `8f65110` pimclaw agents v0.3
- `f9c4803` / `ba40711` pimclaw agents v0.3, implementation 1 & 2
- `b6428ff` update todo list
- `1ea6eb3` workspace-aware deployment paths
- `6f08ca7` / `7b778ff` fix planner in openclaw 4.1
- `333b3ba` document openclaw 4.1 planner compatibility
- `f5a72b2` support multiple inference engines simultaneously
- `a91a93c` **pimclaw v3 implementation** — major rewrite

**Phase 3: MCP Integration** (Apr 7 – Apr 10)
- `f368623` add pimclaw_query_metrics with Prometheus/vLLM integration
- `79d0e14` add SGLang PromQL map and live integration test
- `aa82849` update design doc
- `42d2417` integrate Worker with qianjin-xuntui Engine MCP
- `196c875` integrate Planner with perfllm Perf MCP
- `31cd38d` integrate Planner with Hisim Simulator MCP
- `b6f48ee` enable web_search for Planner
- `3ad8cc3` Head agent 5-minute range queries
- `28fc4a0` full-pipeline E2E test
- `e097e27` register AnomalyReceiver, PlannerTrigger, TaskStatusRecorder
- `10928b3` fake prometheus server

**Phase 4: Observability & Feedback** (Apr 17 – Apr 23)
- `3302cdb` pimclaw implementation (consolidation)
- `cb102d8` / `2e8799b` / `7fd70bf` logger implementation
- `154a61f` **group anomalies by deployment, one Planner per deployment** — important architectural change
- `77184d0` align planner trigger completion with task readiness
- `a32b0aa` improve planner launch observability
- `a30e777` / `fe11fa4` planner feedback memory context + observability
- `5e0cd31` Head follow-up task feedback
- `76b493a` debug logs for Head feedback flow
- `9262061` git-commit agent doc, planner-trigger updates

**Phase 5: Deployment Hardening** (Apr 27 – Apr 28)
- `97d9621` pimclaw updates
- `43ae4ae` prevent OpenClaw config clobbering and plugin duplicate on PVC seed
- `1ad412e` use proper OpenClaw meta fields
- `2096995` migrate config to K8s Secret/ConfigMap, add deploy script
- `356e2bc` add pre-downloaded Python wheels for offline Docker build

### Key Architectural Decisions in Git History
- `154a61f`: Anomalies are grouped by deployment → one Planner invocation per deployment group (not per event)
- `a91a93c`: v3 rewrite moved Head and Planner to external agents
- `5e0cd31`: Head follow-up feedback with settling delay + validity window
- `2096995`: Config migrated from inline JSON to K8s Secret/ConfigMap

## Current Behavioral Notes

- `npm run build` (`tsc`) passes
- `npm test` (`vitest`) has some environment-sensitive and stale test failures
- The worktree is dirty — uncommitted changes under `cicd/`, `agents/`, `docs/`, `tmp/` (tmp/ has deleted files)
- `cicd/openclaw.json` contains live credentials — treat carefully, never commit changes without review
- `agents/pimclaw-head/AGENTS.md` and `agents/pimclaw-planner/AGENTS.md` may not be identical to the corresponding sections in root `AGENTS.md` — check both before changing agent behavior
- The `cicd/cron/jobs.json` is deleted in the dirty worktree; the K8s init container still copies it — possible cron seeding mismatch
- The `openclaw-latest` container uses `http://host.docker.internal:29001/` to reach Prometheus (host bridges to `10.1.112.237:29000`)

## Quick Reference: Read Order

For a new session, read in this order:

1. `REPO_MEMORY.md` (this file)
2. `AGENTS.md` — Head + Planner system prompts (defines agent behavior)
3. `openclaw.plugin.json` — plugin manifest + config schema
4. `src/openclaw-plugin.ts` — main plugin (service lifecycle + all tools)
5. `src/master/anomaly-receiver.ts` — event validation + Planner trigger logic
6. `src/master/planner-trigger.ts` — Planner agent spawning
7. `src/master/task-status-recorder.ts` — task state machine
8. `src/master/scheduler-agent.ts` → `src/master/worker-agent.ts` → `src/master/task-executor.ts` — execution path
9. `src/types/tasks.ts` — Task type definitions

## Important Code Locations

| What | Where |
|------|-------|
| Plugin entry + all tool definitions | `src/openclaw-plugin.ts:2182` (`definePluginEntry`) |
| Service lifecycle (start/stop) | `src/openclaw-plugin.ts:815` (`createPimClawService`) |
| Planner fallback logic | `src/openclaw-plugin.ts:768` (`applyFallbackPlan`) |
| Head feedback review window | `src/master/head-task-feedback.ts:19` (`getHeadTaskFeedbackReviewState`) |
| Anomaly deduplication | `src/master/anomaly-receiver.ts:325` (`isDuplicate`) |
| Deployment grouping | `src/master/anomaly-receiver.ts:171` (Phase 2 grouping) |
| Planner memory sync | `src/master/worker-agent.ts:92` (`syncPlannerMemory`) |
| Task status transitions | `src/master/task-status-recorder.ts:38` (`allowedTransitions`) |
| PromQL maps (vLLM/SGLang) | `src/master/prometheus-client.ts:101` / `:115` |
| Engine MCP auth lifecycle | `src/master/engine-mcp-client.ts` (login → token → tenant) |
| CLI planner fallback | `src/openclaw-plugin.ts:550` (`createCliPlannerAgentApi`) |
