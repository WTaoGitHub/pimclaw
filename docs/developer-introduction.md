# PimClaw Developer Guide

## What PimClaw Is

PimClaw (Pagoda Inference Model Claw) is an LLM deployment orchestration system using a **v2 hybrid architecture**. It runs as a native OpenClaw plugin and also exposes its management surface through MCP for portability to other agent frameworks.

PimClaw does three things:

1. **Detects anomalies** — an external LLM Head Agent (cron `*/5 * * * *`) collects Grafana metrics and submits detected anomalies via the `pimclaw_submit_anomalies` tool.
2. **Plans configurations** — an external LLM Planner Agent is spawned per anomaly to determine optimal deployment config using historical perf data and simulation, submitting via `pimclaw_plan_task`.
3. **Executes deterministically** — programmatic components inside the plugin (Scheduler, Workers, Task Status Recorder) handle task scheduling, concurrency, execution, and state persistence.

Ten tools are registered with OpenClaw so any agent session can submit tasks, check health, and inspect state.

PimClaw is the coordination and reasoning layer. It does not store benchmark data, collect metrics, or modify Kubernetes state directly — those responsibilities are delegated to external MCP services.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  OpenClaw Process                                   │
│                                                     │
│  PimClaw Plugin (definePluginEntry)                 │
│  ┌───────────────────────────────────────────────┐  │
│  │  Service: pimclaw-components                  │  │
│  │                                               │  │
│  │   ComponentRegistry      (in-memory state)    │  │
│  │   TaskStatusRecorder     (persisted to disk)  │  │
│  │       ↓                                       │  │
│  │   AnomalyReceiver        (validates events)   │  │
│  │     + PlannerTrigger      (spawns Planner)    │  │
│  │       ↓                                       │  │
│  │   Scheduler.run()         (polls & dispatches)│  │
│  │       ↓ spawns                                │  │
│  │   Workers                 (ephemeral, 1:1)    │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  Tools: pimclaw_submit_anomalies, pimclaw_plan_task,│
│         pimclaw_route_task, pimclaw_health, …       │
│                                                     │
│  LLM Agent Runtime (external)                       │
│    [pimclaw-head]     cron */5 min → Grafana MCP    │
│    [pimclaw-planner]  on-demand → Perf/Sim MCP      │
│                                                     │
│  External MCP Services                              │
│    engine   ── deployment execution (Workers)       │
└─────────────────────────────────────────────────────┘
```

### Component roles

| Component | Type | Lifecycle | Purpose |
|-----------|------|-----------|---------|
| **LLM Head Agent** | External LLM agent | Cron `*/5 * * * *` via OpenClaw runtime | Collect Grafana metrics → detect anomalies → call `pimclaw_submit_anomalies` |
| **LLM Planner Agent** | External LLM agent | On-demand, ephemeral session | Query Perf/Simulator MCP → determine optimal config → call `pimclaw_plan_task` |
| **AnomalyReceiver** | Plugin component | Created on `start` | Validate incoming events, dedup, rate-limit, trigger PlannerTrigger |
| **PlannerTrigger** | Plugin component | Created on `start` | Spawn Planner agent via OpenClaw API with event context |
| **Scheduler** | Plugin component | Long-running loop (5 sec interval) | Pick up `ready` tasks → enforce concurrency → dispatch Workers |
| **Worker** | Plugin component | Ephemeral (one per task) | Execute a single task via Engine MCP → report result → self-destruct |
| **TaskStatusRecorder** | Plugin component | Passive (no loop) | 8-state task state machine + JSON file persistence |
| **ComponentRegistry** | Plugin component | Passive | In-memory status tracking + health checks for plugin components |

## Source layout

```
src/
├── index.ts                    # barrel — re-exports plugin + all building blocks
├── openclaw-plugin.ts          # OpenClaw plugin entry (service + 10 tools + fallback logic)
├── config-manager.ts           # YAML config loader with ${ENV_VAR} substitution
├── master/
│   ├── base-agent.ts           # abstract base: lifecycle, MCP clients, registry
│   ├── anomaly-receiver.ts     # validates LLM Head events, triggers Planner
│   ├── planner-trigger.ts      # spawns Planner agent via OpenClaw API
│   ├── component-registry.ts   # in-memory component status (EventEmitter)
│   ├── scheduler-agent.ts      # task polling & concurrency
│   ├── task-status-recorder.ts # task CRUD & persistence (8-state machine)
│   ├── worker-agent.ts         # ephemeral task executor
│   ├── mcp-server.ts           # standalone MCP server (tools via stdio)
│   ├── cli.ts                  # CLI tool (commander)
│   └── __tests__/              # unit tests
├── __tests__/
│   └── e2e.test.ts             # end-to-end test suite
└── types/
    ├── index.ts                # barrel re-export
    ├── agents.ts               # AgentType, AgentStatus, AgentRuntimeStatus, AgentConfig
    ├── tasks.ts                # Task, TaskStatus, MetricsSnapshot, DetectedEvent
    └── models.ts               # PerformanceBenchmark, Deployment, MetricRule
AGENTS.md                       # LLM Head & Planner agent definitions and system prompts
types/
└── openclaw-plugin-sdk.d.ts    # ambient declarations for openclaw/plugin-sdk
```

## Key data flows

### 1. Plugin startup (inside OpenClaw)

```
openclaw-plugin.ts  start(ctx)
  → new ComponentRegistry()
  → new TaskStatusRecorder(ctx.stateDir + '/pimclaw-tasks')
  → recorder.initialize()          # loads tasks.json, expires stale tasks
                                   # (planning >10min, ready >60s, scheduling >30s → expired)
  → new PlannerTrigger(openclawApi, plannerConfig)
  → new AnomalyReceiver(recorder, plannerTrigger, config, hooks)
                                   # hooks: onPlanningTaskCreated → schedule fallback timer
                                   #        onPlannerTriggerFailed → apply fallback immediately
  → new Scheduler(registry, recorder)
  → scheduler.initialize()         # registers in registry, connects MCP
  → scheduler.run()                # background: polls every 5s
```

### 2. Anomaly detection flow (LLM Head → Plugin → LLM Planner)

```
[LLM Head Agent]  (cron, every 5 min)
  → calls Grafana MCP tools → collects metrics
  → reasons about anomalies using session history
  → calls pimclaw_submit_anomalies({ events: [...] })

AnomalyReceiver.receive(events)
  → validate each event (type, metric, values)
  → deduplicate (same metric+deployment within 10min)
  → rate-limit (max 20 per submission)
  → for each valid event:
      → create task in 'planning' state
      → hooks.onPlanningTaskCreated(taskId)   # starts fallback timer
      → PlannerTrigger.trigger(event, taskId) # spawns Planner agent

[LLM Planner Agent]  (ephemeral, one-shot)
  → queries Perf MCP (historical configs)
  → simulates via Simulator MCP (predicted outcomes)
  → calls pimclaw_plan_task({ taskId, taskType, config, reasoning, ... })

openclaw-plugin.ts  pimclaw_plan_task handler
  → validates task exists in 'planning' state
  → attaches config, reasoning, evidence to task
  → clears fallback timer
  → transitions task: planning → ready
```

### 3. Task lifecycle

```
planning → ready → scheduling → scheduled → running → done
                                                    → failed → (retry: back to ready)
                                                              → (max retries: stays failed)
planning → ready  (via pimclaw_plan_task OR fallback timeout)
ready → expired   (if waiting > 60s, or manually revoked)
planning → expired (if stale > 10min on restart)
```

### 4. Tool invocation (from OpenClaw agent session)

```
Agent session: "Scale up gpt-4-prod"
  → OpenClaw calls pimclaw_route_task({ llmDeploymentName: "gpt-4-prod", taskType: "scale-up" })
  → openclaw-plugin.ts creates a Task (status: ready) in TaskStatusRecorder
  → Scheduler picks it up on next poll
  → Scheduler creates a Worker
  → Worker calls Engine MCP → reports result
  → Agent session can check with pimclaw_list_tasks or pimclaw_task_counts
```

## Key constants & thresholds

| Where | Constant | Value | What it does |
|-------|----------|-------|--------------|
| LLM Head Agent | Observation interval | 5 min (cron) | Detection cycle frequency |
| LLM Head Agent | Spike threshold | > 200% | Guideline in system prompt |
| LLM Head Agent | Drop threshold | < 50% | Guideline in system prompt |
| LLM Head Agent | Task capacity | 50 | Check via `pimclaw_task_counts` before submitting |
| AnomalyReceiver | `maxEventsPerSubmission` | 20 | Rate limit per tool call |
| AnomalyReceiver | `deduplicationWindowMs` | 10 min | Same metric+deployment dedup window |
| Plugin (fallback) | `planningTimeoutMs` | 10 min | Fallback timer for planning tasks |
| Plugin (fallback) | `fallbackTaskType` | `scale-up` | Default task type when Planner fails |
| Plugin (fallback) | `fallbackConfig` | `{ replicaDelta: 1 }` | Default config when Planner fails |
| Scheduler | `pollingIntervalMs` | 5 sec | Task polling frequency |
| Scheduler | `maxConcurrentWorkers` | 10 | Worker concurrency cap |
| Scheduler | Task expiry | 60 sec | Ready tasks older than this are expired |
| Worker | `executionTimeout` | 30 min | `Promise.race` timeout per task |
| TaskStatusRecorder | Ready expiry (init) | 60 sec | Stale ready tasks expired on load |
| TaskStatusRecorder | Scheduling expiry (init) | 30 sec | Stale scheduling tasks expired on load |
| TaskStatusRecorder | Planning expiry (init) | 10 min | Stale planning tasks expired on load |
| ComponentRegistry | Idle threshold | 30 min | Flags components as idle |
| ComponentRegistry | Error threshold | > 5 | Flags components with excess errors |

## Development workflow

### Setup

```bash
npm install          # install all dependencies
npm run build        # compile TypeScript → dist/
```

### Daily loop

```bash
npm run dev          # tsc --watch
npm test             # vitest (unit + e2e)
npm run lint         # eslint src/
```

### Run E2E tests

```bash
npx vitest run src/__tests__/e2e.test.ts
```

The E2E suite covers the v2 integration boundary (anomaly submission → planning → ready transition) and component flows without MCP services — Planner triggering uses mock APIs, MCP connection failures are caught gracefully.

### CLI inspection

```bash
npx tsx src/master/cli.ts health
npx tsx src/master/cli.ts tasks list --status ready
npx tsx src/master/cli.ts components list
```

Note: the CLI creates standalone `ComponentRegistry` / `TaskStatusRecorder` instances — it does not connect to running components.

## How to approach changes

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

### Wiring ConfigurationManager to components

`ConfigurationManager` is implemented but **not yet wired** into component constructors. Components currently hardcode their MCP service configs and thresholds. To activate config-driven setup:

1. Load config in `openclaw-plugin.ts` → `start()` before creating components
2. Pass `config.agents.scheduler`, etc. into constructors
3. Replace hardcoded MCP service definitions in `WorkerAgent` with `config.mcp.services`

### Adding a new component type

1. Add the type to `AgentType` in `src/types/agents.ts`
2. Create a new class extending `BaseAgent` in `src/master/`
3. Implement `run()` with the component's main loop
4. Instantiate and start it in `openclaw-plugin.ts` → `start()` (and shut down in `stop()`)
5. Add relevant counters to `AgentCounters` in `src/types/agents.ts`
6. Write tests

## Testing strategy

| Layer | Tests | Location |
|-------|-------|----------|
| E2E (v2 integration) | integration boundary + component flows | `src/__tests__/e2e.test.ts` |
| ComponentRegistry | unit tests | `src/master/__tests__/component-registry.test.ts` |
| AnomalyReceiver | unit tests | `src/master/__tests__/anomaly-receiver.test.ts` |
| SchedulerAgent | unit tests | `src/master/__tests__/scheduler-agent.test.ts` |
| TaskStatusRecorder | unit tests | `src/master/__tests__/task-status-recorder.test.ts` |

E2E tests run against real classes with mock Planner APIs — no external MCP services needed. The entire anomaly → planning → ready → scheduling flow is testable without external dependencies.

To run all tests: `npm test`  
To run with coverage: `npm run test:coverage`

## Persistence

All persistent state lives under `stateDir` (provided by OpenClaw) or the configured `storagePath`:

```
<stateDir>/
  pimclaw-tasks/
    tasks.json              # all task records
```

The file is plain JSON, read on startup (`initialize()`) and written on shutdown (`persist()`). The task recorder also writes periodically during operation.

LLM Head Agent observation history is persisted via OpenClaw's session system (not in the plugin's `stateDir`). The Planner uses ephemeral sessions — no history accumulation.

## MCP integration boundary

PimClaw acts as both an **MCP client** (workers call external tools) and an **MCP server** (exposes its own tools). In v2, the LLM agents (Head, Planner) handle most MCP client calls directly via OpenClaw's agent runtime.

### As MCP client (outbound)

Handled in `BaseAgent.connectToMCPServices()` using `@modelcontextprotocol/sdk`:

| Component | MCP Service | Tool called |
|-----------|-------------|-------------|
| Worker | `engine` | `execute_deployment_change` |
| LLM Head Agent (external) | `grafana` | Metrics collection (via OpenClaw agent tools) |
| LLM Planner Agent (external) | `perf` | Historical performance data (via OpenClaw agent tools) |
| LLM Planner Agent (external) | `simulator` | Load simulation (via OpenClaw agent tools) |

Connection failures are caught — components continue running with fallback behavior.

### As MCP server (inbound)

`PimClawMCPServer` in `src/master/mcp-server.ts` exposes PimClaw tools over stdio for external frameworks that want to interact with PimClaw without going through OpenClaw.

### Integration gates (LLM ↔ Plugin)

Two structured data gates connect the LLM agents to the plugin:

| Gate | Direction | Tool | Purpose |
|------|-----------|------|---------|
| Gate 1 | Head → Plugin | `pimclaw_submit_anomalies` | Anomaly events with metric values and reasoning |
| Gate 2 | Planner → Plugin | `pimclaw_plan_task` | Deployment config with evidence and simulation results |

Both gates validate inputs before acting. Invalid events/plans are rejected. The plugin applies fallback configs on Planner timeout or failure.

## Known constraints

- MCP service endpoints for Workers are hardcoded in agent constructors (`ConfigurationManager` is not yet wired in)
- The CLI creates fresh instances rather than connecting to a running system
- Worker creation in the Scheduler is partially stubbed (tracks `activeWorkers` but full Worker spawn is TODO)
- `Deployment.kubeernetesPodName` has a typo in `src/types/models.ts`
- OpenClaw SDK types are ambient declarations — PimClaw can be built without the OpenClaw host checkout
- LLM Head and Planner agents require OpenClaw agent runtime to be configured separately (see `AGENTS.md`)
- Late Planner responses after fallback has already promoted a task to `ready` are rejected (task is no longer in `planning` state)

## Recommended reading order

1. This guide
2. `src/openclaw-plugin.ts` — the real entry point; shows how everything boots and how fallback works
3. `AGENTS.md` — LLM Head and Planner agent definitions and system prompts
4. `src/master/anomaly-receiver.ts` — the Head→Plugin integration gate
5. `src/master/planner-trigger.ts` — how Planner agents are spawned
6. `src/master/base-agent.ts` — lifecycle pattern shared by Scheduler and Workers
7. `src/master/scheduler-agent.ts` — task dispatch
8. `src/master/task-status-recorder.ts` — 8-state machine
9. `src/types/tasks.ts` — data shapes (including planning fields)
10. `src/__tests__/e2e.test.ts` — see v2 features exercised
11. `docs/howtointegratewithopenclaw.md` — plugin integration guide
12. `docs/install.md` — build, package, deliver