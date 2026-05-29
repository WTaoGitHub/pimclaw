# PimClaw Requirements

## 1. Purpose

PimClaw (Pagoda Inference Model Claw) is an **LLM deployment orchestration system** that autonomously monitors LLM inference services, detects performance anomalies, plans optimal configurations, and executes deployment changes — all through a multi-agent subsystem running inside the OpenClaw agent framework.

It uses a **v2 hybrid architecture**: two external LLM agents (Head + Planner) handle reasoning-heavy tasks (anomaly detection and configuration planning), while deterministic TypeScript components inside the plugin handle task scheduling and execution.

## 2. Functional Requirements

### 2.1 Metric Collection

- Query Prometheus for real-time LLM inference metrics
- Support multiple inference engines: **vLLM** and **SGLang**, each with engine-specific PromQL query maps
- Collect six metric types: TTFT (time to first token), TPOT (time per output token), QPS (queries per second), throughput (tokens/second), GPU utilization, and error rate
- Support instant queries and time-series range queries (5-minute windows)
- Support per-metric PromQL overrides via configuration

### 2.2 Anomaly Detection

- Run an external LLM **Head Agent** every 5 minutes (cron-triggered via OpenClaw)
- The Head Agent compares current 5-minute metric averages against prior observations
- Detect spikes (>200% increase), drops (>50% decrease), and gradual trends
- Correlate multiple metrics (e.g., TTFT spike + QPS spike = load-driven; TTFT spike + flat QPS = model degradation)
- Rate-limit anomaly submissions: max 20 events per call
- Deduplicate identical metric+deployment combinations within a 10-minute window
- Submit structured anomaly events to the plugin via `pimclaw_submit_anomalies` tool

### 2.3 Configuration Planning

- Spawn an external LLM **Planner Agent** per anomaly event group (grouped by deployment)
- The Planner queries **Perf MCP** for historical benchmark data and **Simulator MCP** for performance predictions
- The Planner may optionally search the web for known solutions
- Submit an optimal deployment configuration via `pimclaw_plan_task` tool
- Apply a fallback configuration if the Planner times out (10-minute default timeout) or fails

### 2.4 Task Execution

- **Scheduler** polls for ready tasks every 5 seconds
- Enforce maximum concurrency: 10 workers by default
- **Worker** executes a single task via **Engine MCP** (qianjin-xuntui platform)
- Support four task types: `scale-up`, `scale-down`, `restart`, `reconfigure`
- Apply retry logic for failed tasks (max 3 retries)
- Timeout individual worker execution at 30 minutes

### 2.5 Task State Management

- Maintain 8 task states: `planning → ready → scheduling → scheduled → running → done/failed/expired`
- Persist all task state to JSON file in `stateDir`
- Recover and expire stale tasks on startup:
  - `planning` > 10 minutes → expired
  - `ready` > 60 seconds → expired
  - `scheduling` > 30 seconds → expired
- Support manual operations: route, retry, revoke tasks

### 2.6 Integration Surface

The plugin registers **22 tools** with OpenClaw, serving three callers:

| Caller | Tools |
|--------|-------|
| **Head Agent** | `pimclaw_query_metrics`, `pimclaw_submit_anomalies`, `pimclaw_submit_task_feedback`, `pimclaw_task_counts`, `pimclaw_list_tasks` |
| **Planner Agent** | `pimclaw_plan_task`, `pimclaw_query_perfllm`, `pimclaw_get_perfllm_schema`, `pimclaw_sim_*` (6 tools), `pim_get_hf_models`, `pimclaw_list_tasks` |
| **Operator** | `pimclaw_route_task`, `pimclaw_health`, `pimclaw_list_components`, `pimclaw_component_status`, `pimclaw_task_counts`, `pimclaw_list_tasks`, `pimclaw_retry_task`, `pimclaw_revoke_task` |

### 2.7 Head Follow-up Feedback

- The Head Agent may review completed tasks within a configurable validity window
- Settling delay: 15 minutes (default) after completion before review is eligible
- Feedback validity window: 1 hour (default) after which review is expired
- Submit structured feedback: outcome (helped/no-effect/worsened/unknown), metric assessments, status summary

## 3. Non-Functional Requirements

### 3.1 Performance

| Aspect | Requirement |
|--------|------------|
| Anomaly detection cycle | Every 5 minutes (configurable) |
| Task polling interval | 5 seconds |
| Max concurrent workers | 10 (configurable) |
| Max events per submission | 20 |
| Deduplication window | 10 minutes |
| Planner timeout | 10 minutes (configurable) |
| Worker execution timeout | 30 minutes |

### 3.2 Reliability

- Task state is persisted to disk and survives restarts
- Planner fallback: if Planner times out or fails, fallback config is applied automatically
- MCP connection failures are caught — components continue with fallback behavior
- Stale tasks are expired on startup to prevent state corruption
- Idle detection: components flagged as idle after 30 minutes of inactivity

### 3.3 Security

- No direct database or Kubernetes access — all external interactions through MCP services
- MCP credentials via environment variables, never hardcoded
- Tool policy pipeline controls which MCP tools are available in which agent contexts
- Plugin disabled by default; requires explicit enablement in OpenClaw config

### 3.4 Portability

- PimClaw is an OpenClaw native plugin (not a standalone daemon)
- All capabilities also exposed via a standalone MCP server (stdio) for other frameworks (CrewAI, LangGraph, etc.)
- Plugin API compatibility: `>= 2026.1.0`

## 4. Supported Environments

| Engine | PromQL Support |
|--------|---------------|
| vLLM | Full (TTFT, TPOT, QPS, GPU utilization) |
| SGLang | Full (TTFT, TPOT, QPS, GPU utilization) |

| Model Families | |
|----------------|---|
| Managed deployments | Qwen, MiniMax, GLM, HuggingFace models (extensible) |

| Runtime | |
|---------|---|
| Host | OpenClaw (`>= 2026.1.0`) |
| Node.js | `>= 22.16.0` |
| Module system | ESM |

## 5. Task Types

| Task Type | Description |
|-----------|------------|
| `scale-up` | Increase deployment capacity (replicas, resources) |
| `scale-down` | Decrease deployment capacity |
| `restart` | Restart deployment service |
| `reconfigure` | Change deployment parameters (dtype, quantization, batch size, tensor parallelism) |

## 6. Agent System Requirements

### 6.1 Head Agent (pimclaw-head)

- Cron schedule: `*/5 * * * *`
- Model: configurable (default: `minimax-m2_1`), thinking disabled
- Persistent session: accumulates observation history across cycles
- Tools: metric query, anomaly submission, task feedback, task listing, task counts
- Fixed session key for history accumulation

### 6.2 Planner Agent (pimclaw-planner)

- Trigger: on-demand per deployment anomaly group (not cron)
- Model: configurable (default: `minimax-m2_1`), thinking enabled
- Ephemeral session: one-shot per invocation, deleted after completion
- Subagent depth: 0 (no subagent spawning)
- Tools: Perf MCP, Simulator MCP, web search, plan submission
