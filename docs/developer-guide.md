# PimClaw Developer Guide

## What PimClaw Is

PimClaw is an LLM deployment orchestration system using a **v2 hybrid architecture**. It runs as a native OpenClaw plugin. PimClaw does three things:

1. **Detects anomalies** — an external LLM Head Agent (cron `*/5 * * * *`) collects Prometheus metrics and submits detected anomalies via the `pimclaw_submit_anomalies` tool.
2. **Plans configurations** — an external LLM Planner Agent is spawned per deployment anomaly group to determine optimal deployment config using historical perf data and simulation, submitting via `pimclaw_plan_task`.
3. **Executes deterministically** — programmatic components inside the plugin (Scheduler, Workers, TaskStatusRecorder) handle task scheduling, concurrency, execution, and state persistence.

PimClaw is the coordination and reasoning layer. It does not store benchmark data, collect metrics, or modify Kubernetes state directly — those responsibilities are delegated to external MCP services.

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | >= 22.16.0 |
| npm | >= 10 |
| TypeScript | >= 5.3 (devDependency) |

## Setup

```bash
npm install          # install all dependencies
npm run build        # compile TypeScript → dist/
npm run dev          # tsc --watch
```

## Source Layout

```
src/
├── index.ts                    # barrel — re-exports plugin + all building blocks
├── openclaw-plugin.ts          # OpenClaw plugin entry (service + 22 tools + fallback logic)
├── config-manager.ts           # YAML config loader (legacy, not wired)
├── master/
│   ├── base-agent.ts           # abstract base: lifecycle, MCP clients, registry
│   ├── anomaly-receiver.ts     # validates LLM Head events, triggers Planner
│   ├── planner-trigger.ts      # spawns Planner agent via OpenClaw API
│   ├── planner-launch.ts       # selects native API vs CLI fallback
│   ├── component-registry.ts   # in-memory component status (EventEmitter)
│   ├── scheduler-agent.ts      # task polling & concurrency
│   ├── task-status-recorder.ts # task CRUD & persistence (8-state machine)
│   ├── worker-agent.ts         # ephemeral task executor
│   ├── task-executor.ts        # maps task types to Engine MCP calls
│   ├── prometheus-client.ts    # Prometheus HTTP client + PromQL maps
│   ├── metrics-store.ts        # ring-buffer metrics persistence
│   ├── head-summary-store.ts   # monitoring summary persistence
│   ├── head-task-feedback.ts   # feedback review window logic
│   ├── planner-memory-store.ts # planner learning persistence
│   ├── engine-mcp-client.ts    # SSE MCP client for qianjin-xuntui
│   ├── perf-mcp-client.ts      # stdio MCP client for perfllm Python
│   ├── sim-mcp-client.ts       # SSE MCP client for Hisim simulator
│   ├── file-logger.ts          # rotating file logger
│   ├── mcp-server.ts           # standalone MCP server (legacy)
│   └── cli.ts                  # CLI tool (legacy)
├── types/
│   ├── index.ts                # re-exports from agents, models, planner-memory, tasks
│   ├── agents.ts               # AgentType, AgentStatus, AgentRuntimeStatus, AgentConfig
│   ├── tasks.ts                # Task, TaskStatus, TaskFeedback, MetricsSnapshot, DetectedEvent
│   ├── planner-memory.ts       # PlannerMemoryEpisode, Lesson, Index types
│   └── models.ts               # PerformanceBenchmark, Deployment, MetricRule
├── __tests__/
│   ├── full-pipeline-e2e.test.ts
│   ├── openclaw-plugin-feedback.e2e.test.ts
│   ├── openclaw-plugin-plan-task.e2e.test.ts
│   └── e2e.test.ts
└── master/__tests__/            # unit tests per component (18 files)

AGENTS.md                        # LLM Head & Planner agent definitions + system prompts
openclaw.plugin.json             # OpenClaw plugin manifest + config schema
```

## Development Workflow

### Daily loop

```bash
npm run dev          # tsc --watch
npm test             # vitest (unit + e2e)
npm run lint         # eslint src/
```

### Run specific tests

```bash
npx vitest run src/__tests__/e2e.test.ts
npx vitest run src/master/__tests__/anomaly-receiver.test.ts
```

### Run with coverage

```bash
npm run test:coverage
```

### CLI inspection

```bash
npx tsx src/master/cli.ts health
npx tsx src/master/cli.ts tasks list --status ready
npx tsx src/master/cli.ts components list
```

> Note: the CLI creates standalone `ComponentRegistry` / `TaskStatusRecorder` instances — it does not connect to running components.

## Project Scripts

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Build | `npm run build` |
| Watch mode | `npm run dev` |
| Run tests | `npm test` |
| Lint | `npm run lint` |
| Pack tarball | `npm pack` |
| Publish | `npm publish` |
| CLI inspect | `npm run cli` / `node dist/master/cli.js` |

## How to Approach Changes

### Adding a new tool

1. Add the tool factory function in `src/openclaw-plugin.ts` (follow the `routeTaskTool` pattern)
2. Add it to the `buildPimClawTools()` return array
3. Add the tool name to `openclaw.plugin.json` → `contracts.tools`
4. Optionally mirror it in `src/master/mcp-server.ts` for standalone MCP use
5. Add a test in `src/__tests__/e2e.test.ts` under "Plugin tool flows"

### Changing component behavior

| What | Start here |
|------|-----------|
| Anomaly detection thresholds | `AGENTS.md` → pimclaw-head system prompt |
| Configuration planning logic | `AGENTS.md` → pimclaw-planner system prompt |
| Anomaly event validation/dedup | `src/master/anomaly-receiver.ts` |
| Planner agent spawning | `src/master/planner-trigger.ts` |
| Planner fallback behavior | `src/openclaw-plugin.ts` → fallback helpers |
| Polling interval or concurrency | `src/master/scheduler-agent.ts` (constructor / field defaults) |
| Task state transitions | `src/master/task-status-recorder.ts` → `updateTaskStatus()` |
| Task execution / MCP calls | `src/master/worker-agent.ts` → `executeTask()` |
| Component registration / health | `src/master/component-registry.ts` |
| Engine MCP auth lifecycle | `src/master/engine-mcp-client.ts` |
| PromQL maps (vLLM/SGLang) | `src/master/prometheus-client.ts` |

### Adding a new component type

1. Add the type to `AgentType` in `src/types/agents.ts`
2. Create a new class extending `BaseAgent` in `src/master/`
3. Implement `run()` with the component's main loop
4. Instantiate and start it in `openclaw-plugin.ts` → `start()` (and shut down in `stop()`)
5. Add relevant counters to `AgentCounters` in `src/types/agents.ts`
6. Write tests

### Wiring ConfigurationManager to components

`ConfigurationManager` is implemented but **not yet wired** into component constructors. Components currently hardcode their MCP service configs and thresholds. To activate config-driven setup:

1. Load config in `openclaw-plugin.ts` → `start()` before creating components
2. Pass `config.agents.scheduler`, etc. into constructors
3. Replace hardcoded MCP service definitions in `WorkerAgent` with `config.mcp.services`

## Testing Strategy

| Layer | Tests | Location |
|-------|-------|----------|
| E2E (v2 integration) | Full pipeline + feedback + plan-task flows | `src/__tests__/` |
| ComponentRegistry | unit tests | `src/master/__tests__/component-registry.test.ts` |
| AnomalyReceiver | unit tests | `src/master/__tests__/anomaly-receiver.test.ts` |
| SchedulerAgent | unit tests | `src/master/__tests__/scheduler-agent.test.ts` |
| TaskStatusRecorder | unit tests | `src/master/__tests__/task-status-recorder.test.ts` |
| PrometheusClient | unit + live integration | `src/master/__tests__/prometheus-client.*.test.ts` |

E2E tests run against real classes with mock Planner APIs — no external MCP services needed. The entire anomaly → planning → ready → scheduling flow is testable without external dependencies.

## Persistence

All persistent state lives under `stateDir` (provided by OpenClaw):

```
<stateDir>/
  pimclaw-tasks/
    tasks.json              # all task records
```

The file is plain JSON, read on startup (`initialize()`) and written on shutdown (`persist()`). The task recorder also writes periodically during operation.

LLM Head Agent observation history is persisted via OpenClaw's session system (not in the plugin's `stateDir`). The Planner uses ephemeral sessions — no history accumulation.

## MCP Integration Boundary

### As MCP Client (outbound)

Handled in `BaseAgent.connectToMCPServices()` using `@modelcontextprotocol/sdk`:

| Component | MCP Service | Tool called |
|-----------|-------------|-------------|
| Worker | Engine (qianjin-xuntui) | `execute_deployment_change` |
| Scheduler | Engine | Health check |
| PrometheusClient | Prometheus (HTTP, not MCP) | `/api/v1/query`, `/api/v1/query_range` |
| PerfMcpClient | perfllm (stdio) | `query_perfllm`, `get_perfllm_schema` |
| SimMcpClient | Hisim (SSE) | `sim_start`, `sim_benchmark`, etc. |

Connection failures are caught — components continue running with fallback behavior.

### As MCP Server (inbound)

`PimClawMCPServer` in `src/master/mcp-server.ts` exposes PimClaw tools over stdio for external frameworks that want to interact with PimClaw without going through OpenClaw.

## Key Constants & Thresholds

| Where | Constant | Value |
|-------|----------|-------|
| Head Agent | Observation interval | 5 min (cron) |
| Head Agent | Task capacity check | 50 pending tasks |
| AnomalyReceiver | `maxEventsPerSubmission` | 20 |
| AnomalyReceiver | `deduplicationWindowMs` | 10 min |
| Plugin (fallback) | `planningTimeoutMs` | 10 min |
| Plugin (fallback) | `fallbackTaskType` | `scale-up` |
| Plugin (fallback) | `fallbackConfig` | `{ replicaDelta: 1 }` |
| Scheduler | `pollingIntervalMs` | 5 sec |
| Scheduler | `maxConcurrentWorkers` | 10 |
| Scheduler | Task expiry | 60 sec |
| Worker | `executionTimeout` | 30 min |
| ComponentRegistry | Idle threshold | 30 min |
| ComponentRegistry | Error threshold | > 5 errors |

## Known Constraints

- MCP service endpoints for Workers are hardcoded in agent constructors (`ConfigurationManager` is not yet wired in)
- The CLI creates fresh instances rather than connecting to a running system
- Worker creation in the Scheduler is partially stubbed (tracks `activeWorkers` but full Worker spawn is TODO)
- `Deployment.kubeernetesPodName` has a typo in `src/types/models.ts`
- OpenClaw SDK types are ambient declarations — PimClaw can be built without the OpenClaw host checkout
- LLM Head and Planner agents require OpenClaw agent runtime to be configured separately (see `AGENTS.md`)
- Late Planner responses after fallback has already promoted a task to `ready` are rejected (task is no longer in `planning` state)

## Recommended Reading Order

1. `docs/developer-guide.md` (this file)
2. `src/openclaw-plugin.ts` — the real entry point; shows how everything boots and how fallback works
3. `AGENTS.md` — LLM Head and Planner agent definitions and system prompts
4. `src/master/anomaly-receiver.ts` — the Head→Plugin integration gate
5. `src/master/planner-trigger.ts` — how Planner agents are spawned
6. `src/master/base-agent.ts` — lifecycle pattern shared by Scheduler and Workers
7. `src/master/scheduler-agent.ts` — task dispatch
8. `src/master/task-status-recorder.ts` — 8-state machine
9. `src/types/tasks.ts` — data shapes (including planning fields)
10. `src/__tests__/full-pipeline-e2e.test.ts` — see v2 features exercised
