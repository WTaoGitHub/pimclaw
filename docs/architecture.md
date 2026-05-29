# PimClaw Design and Architecture

## 1. System Overview

PimClaw is an **OpenClaw native plugin** for autonomous LLM deployment orchestration. It monitors LLM inference services via Prometheus, detects anomalies through an external LLM Head agent, plans configuration changes through an external LLM Planner agent, and executes those changes via an Engine MCP (qianjin-xuntui platform).

Architecture principle: **v2 hybrid** — external LLM agents handle reasoning-heavy tasks (detection + planning); deterministic programmatic code inside the plugin handles scheduling and execution.

### High-Level Architecture

```
OpenClaw Process
│
├─ [LLM Agent] pimclaw-head (cron: */5 * * * *)
│   ├─ Tools: pimclaw_query_metrics, pimclaw_submit_anomalies, pimclaw_submit_task_feedback
│   ├─ Session: persistent (accumulates observation history)
│   └─ Job: Detect anomalies only
│
├─ [LLM Agent] pimclaw-planner (triggered per deployment anomaly group)
│   ├─ Tools: Perf MCP, Simulator MCP, Web Search, pimclaw_plan_task
│   ├─ Session: ephemeral (one-shot per invocation)
│   └─ Job: Determine optimal deployment config
│
└─ [Plugin] pimclaw
    ├─ Service: pimclaw-components (lifecycle-managed)
    │   ├─ ComponentRegistry    — in-memory runtime status tracking
    │   ├─ TaskStatusRecorder   — task persistence (JSON) + 8-state machine
    │   ├─ AnomalyReceiver      — validates events, groups by deployment, triggers Planner
    │   ├─ PlannerTrigger       — spawns Planner agent via OpenClaw API
    │   ├─ Scheduler            — polls ready tasks every 5s, dispatches Workers
    │   ├─ Worker               — ephemeral, executes one task via Engine MCP
    │   ├─ PrometheusClient     — HTTP client for Prometheus query/query_range
    │   ├─ MetricsStore         — ring-buffer metric persistence
    │   ├─ HeadSummaryStore     — last 10 monitoring-cycle summaries
    │   ├─ PlannerMemoryStore   — episode/lesson persistence for planner learning
    │   ├─ EngineMcpClient      — SSE transport to qianjin-xuntui MCP
    │   ├─ PerfMcpClient        — stdio transport to perfllm Python MCP
    │   ├─ SimMcpClient         — SSE transport to Hisim simulator MCP
    │   └─ FileLogger           — rotating file-based logger
    │
    └─ Tools (22 total, registered with OpenClaw)
```

## 2. Component Roles

| Component | Type | Lifecycle | Purpose |
|-----------|------|-----------|---------|
| **LLM Head Agent** | External LLM agent | Cron `*/5 * * * *` via OpenClaw runtime | Collect Prometheus metrics, detect anomalies, submit events |
| **LLM Planner Agent** | External LLM agent | On-demand, ephemeral session per deployment group | Query Perf MCP + Simulator MCP, select optimal config |
| **AnomalyReceiver** | Plugin component | Created on `start` | Validate events, dedup, rate-limit, group by deployment, trigger PlannerTrigger |
| **PlannerTrigger** | Plugin component | Created on `start` | Spawn Planner agent via OpenClaw API with event context |
| **Scheduler** | Plugin component | Long-running loop (5 sec interval) | Pick up `ready` tasks, enforce concurrency, dispatch Workers |
| **Worker** | Plugin component | Ephemeral (one per task) | Execute a single task via Engine MCP, report result |
| **TaskStatusRecorder** | Plugin component | Passive (no loop) | Task CRUD, 8-state machine, JSON persistence |
| **ComponentRegistry** | Plugin component | Passive | In-memory status tracking, health reports, EventEmitter |
| **PrometheusClient** | Plugin component | Passive | HTTP client for Prometheus API (query, query_range) |
| **MetricsStore** | Plugin component | Passive | Ring-buffer metric snapshot persistence |
| **EngineMcpClient** | Plugin component | Passive | SSE MCP client for qianjin-xuntui with auth lifecycle |
| **PerfMcpClient** | Plugin component | Passive | Stdio MCP client for perfllm Python server |
| **SimMcpClient** | Plugin component | Passive | SSE MCP client for Hisim simulator server |

## 3. Data Flow

### Flow 1: Plugin Startup

```
openclaw-plugin.ts → start()
  → new ComponentRegistry()
  → new TaskStatusRecorder(stateDir + '/pimclaw-tasks')
  → recorder.initialize()                     # loads tasks.json, expires stale tasks
  → new PlannerTrigger(openclawApi, config)
  → new AnomalyReceiver(recorder, trigger, config, hooks)
  → new Scheduler(registry, recorder)
  → scheduler.initialize()                    # registers in registry, connects MCP
  → scheduler.run()                           # background: polls every 5s
```

### Flow 2: Anomaly Detection → Planning → Execution

```
[Head Agent]  (cron, every 5 min)
  → calls pimclaw_query_metrics { rangeMinutes: 5 }
  → reasons about anomalies using session history
  → calls pimclaw_submit_anomalies({ events: [...] })

AnomalyReceiver.receive(events)
  → validate each event (type, metric, values)
  → deduplicate (same metric+deployment within 10min)
  → rate-limit (max 20 per submission)
  → group events by deployment name
  → for each deployment group:
      → create task in 'planning' state
      → PlannerTrigger.trigger(eventGroup, taskIds)  # spawns Planner

[Planner Agent]  (ephemeral, one-shot per deployment group)
  → queries Perf MCP (historical configs)
  → simulates via Simulator MCP (predicted outcomes)
  → calls pimclaw_plan_task({ taskId, taskType, config, reasoning, ... })

Plugin pimclaw_plan_task handler
  → validates task exists in 'planning' state
  → attaches config, reasoning, evidence to task
  → clears fallback timer
  → transitions task: planning → ready

[Scheduler]  (polls every 5s)
  → picks up ready task
  → transitions: ready → scheduling → scheduled
  → creates Worker

[Worker]  (ephemeral)
  → executes via EngineMcpClient (qianjin-xuntui)
  → reports result (done/failed)
  → self-destructs
```

### Flow 3: Direct Operator Task

```
[OpenClaw agent session]
  → calls pimclaw_route_task({ llmDeploymentName, taskType, ... })
  → plugin creates Task (status: ready, skips planning)
  → Scheduler picks up on next poll → Worker executes
```

## 4. Task State Machine

```
planning → ready → scheduling → scheduled → running → done
                                                     → failed → (retry: back to ready)
                                                               → (max retries: stays failed)
planning → ready  (via pimclaw_plan_task OR fallback timeout)
ready → expired   (if waiting > 60s, or manually revoked)
planning → expired (if stale > 10min on restart)
```

| State | Meaning |
|-------|---------|
| `planning` | Awaiting configuration from Planner agent |
| `ready` | Task is queued and available for scheduling |
| `scheduling` | Scheduler has claimed the task, creating a Worker |
| `scheduled` | Worker has been created and assigned the task |
| `running` | Worker is actively executing the task |
| `done` | Task completed successfully |
| `failed` | Task execution failed |
| `expired` | Task timed out or was revoked |

## 5. MCP Integration Boundary

PimClaw acts as both an **MCP client** (workers call external tools) and exposes its own tools via the OpenClaw plugin API.

### As MCP Client (Outbound)

| Component | MCP Service | Protocol | Purpose |
|-----------|-------------|----------|---------|
| Worker | Engine (qianjin-xuntui) | SSE | Execute deployment changes |
| Scheduler | Engine (qianjin-xuntui) | SSE | Health checks |
| PrometheusClient | Prometheus | HTTP | Metric collection |
| PerfMcpClient | perfllm (PostgreSQL) | Stdio | Historical benchmark queries |
| SimMcpClient | Hisim simulator | SSE | Performance simulation |

### As MCP Server (Inbound)

`PimClawMCPServer` in `src/master/mcp-server.ts` exposes PimClaw tools over stdio for external frameworks that want to interact without going through OpenClaw.

### Integration Gates (LLM ↔ Plugin)

| Gate | Direction | Tool | Purpose |
|------|-----------|------|---------|
| Gate 1 | Head → Plugin | `pimclaw_submit_anomalies` | Anomaly events with metric values and reasoning |
| Gate 2 | Planner → Plugin | `pimclaw_plan_task` | Deployment config with evidence and simulation results |
| Metrics | Prometheus → Head | `pimclaw_query_metrics` | Metric data input (not a validation gate) |
| Feedback | Head → Plugin | `pimclaw_submit_task_feedback` | Follow-up review of completed tasks |

## 6. Tool Inventory (22 Tools)

| Tool | Caller | Purpose |
|------|--------|---------|
| `pimclaw_query_metrics` | Head | Prometheus queries, grouped by engine |
| `pimclaw_submit_anomalies` | Head | Submit anomaly events |
| `pimclaw_submit_task_feedback` | Head | Submit follow-up feedback for completed tasks |
| `pimclaw_plan_task` | Planner | Submit deployment config plan |
| `pimclaw_route_task` | Operator | Direct task submission (bypasses Head/Planner) |
| `pimclaw_list_components` | Operator | List all component runtime status |
| `pimclaw_component_status` | Operator | Single component status |
| `pimclaw_health` | Operator | System health report |
| `pimclaw_task_counts` | Head/Operator | Task counts by status |
| `pimclaw_list_tasks` | All | List tasks with optional status filter |
| `pimclaw_retry_task` | Operator | Reset failed task for retry |
| `pimclaw_revoke_task` | Operator | Cancel task (mark expired) |
| `pim_get_hf_models` | Planner | Search Hugging Face model catalog |
| `pimclaw_query_perfllm` | Planner | Query perfllm historical benchmark data |
| `pimclaw_get_perfllm_schema` | Planner | Get perfllm table schema |
| `pimclaw_sim_register_hardware` | Planner | Register hardware for simulation |
| `pimclaw_sim_list_hardware` | Planner | List registered hardware |
| `pimclaw_sim_start` | Planner | Start SGLang simulation server |
| `pimclaw_sim_stop` | Planner | Stop simulation server |
| `pimclaw_sim_status` | Planner | Get simulation server status |
| `pimclaw_sim_benchmark` | Planner | Run benchmark against simulation |
| `pimclaw_sim_dataset_info` | Planner | Preview dataset info |

## 7. Plugin Configuration Schema

From `openclaw.plugin.json` configSchema:

| Section | Key Fields |
|---------|-----------|
| `prometheus` | `baseUrl` (required), `engine` (vllm/sglang), `queryOverrides`, `defaultLabels`, auth |
| `engineMcp` | `sseUrl`, `username`, `password` (required), `tenantId` |
| `perfMcp` | `serverScriptPath` (required), `pythonPath`, `env` |
| `simMcp` | `sseUrl` (required) |
| `planner` | `agentId`, `timeoutSeconds` (600), `fallbackTaskType` (scale-up), `fallbackConfig` |
| `anomalyReceiver` | `maxEventsPerSubmission` (20), `deduplicationWindowMs` (600000), `planningTimeoutMs` (600000) |
| `headFeedback` | `settlingDelayMs` (900000), `feedbackValidityMs` (3600000) |

## 8. Persistence Model

```
<stateDir>/
  pimclaw-tasks/
    tasks.json                    # all task records (JSON)
```

Additional persisted data:

| Store | File/Path | Contents |
|-------|-----------|----------|
| TaskStatusRecorder | `stateDir/pimclaw-tasks/tasks.json` | All task records, state machine |
| HeadSummaryStore | Head workspace directory | Last 10 monitoring-cycle summaries |
| PlannerMemoryStore | Planner workspace directory | Learning episodes and lessons |
| MetricsStore | Plugin-managed | Ring-buffer of metric snapshots |

## 9. Fallback Strategy

| Failure | Fallback |
|---------|----------|
| Planner times out (10 min) | Task transitions to `ready` with `fallbackConfig` (default: scale-up by 1 replica) |
| Planner trigger fails | Plugin applies `fallbackConfig` directly |
| MCP connection fails | Components log the error and continue in degraded mode |
| LLM Head unreliable | AnomalyReceiver validates all events; can re-enable programmatic Head |

## 10. Key Design Decisions

1. **Two LLM agents instead of one**: Head runs 288×/day (cheap detection), Planner runs only on anomalies (expensive reasoning). Different reasoning tasks benefit from focused prompts.

2. **Scheduler + Workers stay as code**: Deterministic — polling, concurrency, state transitions don't benefit from LLM reasoning. Code is cheaper, faster, and more predictable.

3. **Anomaly grouping by deployment**: Grouping events by deployment ensures one Planner invocation per affected deployment, delivering coherent config changes.

4. **OpenClaw 4.1 compatibility fallback**: CLI-based planner triggering for older OpenClaw versions that don't expose plugin-to-agent API.

5. **Standalone MCP server**: Dual-path design — tools work via OpenClaw plugin API and via stdio MCP server for portability.

## 11. Source Layout

```
src/
├── index.ts                    # barrel re-export
├── openclaw-plugin.ts          # plugin entry (service + 22 tools + fallback)
├── config-manager.ts           # YAML config loader (legacy, not wired)
├── master/
│   ├── anomaly-receiver.ts     # event validation + Planner trigger
│   ├── planner-trigger.ts      # spawns Planner via OpenClaw API
│   ├── planner-launch.ts       # native API vs CLI fallback selector
│   ├── task-status-recorder.ts # 8-state machine + JSON persistence
│   ├── scheduler-agent.ts      # task polling + concurrency
│   ├── worker-agent.ts         # ephemeral task executor
│   ├── task-executor.ts        # maps task types to Engine MCP calls
│   ├── component-registry.ts   # in-memory status tracking
│   ├── base-agent.ts           # abstract lifecycle base
│   ├── prometheus-client.ts    # Prometheus HTTP client + PromQL maps
│   ├── metrics-store.ts        # ring-buffer metrics persistence
│   ├── head-summary-store.ts   # monitoring summary persistence
│   ├── head-task-feedback.ts   # feedback review window logic
│   ├── planner-memory-store.ts # planner learning persistence
│   ├── engine-mcp-client.ts    # SSE client for qianjin-xuntui
│   ├── perf-mcp-client.ts      # stdio client for perfllm Python
│   ├── sim-mcp-client.ts       # SSE client for Hisim simulator
│   ├── file-logger.ts          # rotating file logger
│   ├── mcp-server.ts           # standalone MCP server (legacy)
│   └── cli.ts                  # CLI tool (legacy)
├── types/
│   ├── index.ts
│   ├── agents.ts               # AgentType, AgentStatus, AgentRuntimeStatus
│   ├── tasks.ts                # Task, TaskStatus, MetricsSnapshot, DetectedEvent
│   ├── planner-memory.ts       # PlannerMemoryEpisode, Lesson types
│   └── models.ts               # PerformanceBenchmark, Deployment, MetricRule
├── __tests__/
│   ├── full-pipeline-e2e.test.ts
│   ├── openclaw-plugin-feedback.e2e.test.ts
│   ├── openclaw-plugin-plan-task.e2e.test.ts
│   └── e2e.test.ts
└── master/__tests__/            # unit tests (18 files)
```

## 12. Compatibility

| Field | Value |
|-------|-------|
| Plugin API | `>= 2026.1.0` |
| Node.js | `>= 22.16.0` |
| Module system | ESM |
| Build | TypeScript → `dist/` |
