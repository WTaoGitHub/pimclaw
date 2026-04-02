# PimClaw Developer Guide

## What PimClaw Is

PimClaw (Pagoda Inference Model Claw) is a multi-agent orchestration layer for LLM inference operations. It runs as a native OpenClaw plugin and also exposes its management surface through MCP for portability to other agent frameworks.

PimClaw does three things:

1. **Monitors** — the Head Agent collects metrics snapshots, detects anomalies (spikes, drops), and plans corrective tasks.
2. **Schedules** — the Scheduler Agent polls for ready tasks, enforces concurrency limits, and dispatches ephemeral Worker Agents.
3. **Exposes tools** — eight tools are registered with OpenClaw so any agent session can submit tasks, check health, and inspect state.

PimClaw is the coordination and reasoning layer. It does not store benchmark data, collect metrics, or modify Kubernetes state directly — those responsibilities are delegated to external MCP services.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  OpenClaw Process                                   │
│                                                     │
│  PimClaw Plugin (definePluginEntry)                 │
│  ┌───────────────────────────────────────────────┐  │
│  │  Service: pimclaw-agents                      │  │
│  │                                               │  │
│  │   AgentRegistry          (in-memory state)    │  │
│  │   TaskStatusRecorder     (persisted to disk)  │  │
│  │       ↓                                       │  │
│  │   HeadAgent.run()        (observe-think-decide│) │
│  │       ↓ creates tasks                         │  │
│  │   SchedulerAgent.run()   (polls & dispatches) │  │
│  │       ↓ spawns                                │  │
│  │   WorkerAgent            (ephemeral, 1:1 task)│  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  Tools: pimclaw_route_task, pimclaw_health, …       │
│                                                     │
│  External MCP Services                              │
│    grafana  ── metrics collection                   │
│    perf     ── benchmark data                       │
│    simulator── load simulation                      │
│    engine   ── deployment execution (Workers)       │
└─────────────────────────────────────────────────────┘
```

### Agent roles

| Agent | Type | Lifecycle | Purpose |
|-------|------|-----------|---------|
| **HeadAgent** | `head` | Long-running loop (5 min interval) | Observe metrics → detect anomalies → plan tasks |
| **SchedulerAgent** | `scheduler` | Long-running loop (5 sec interval) | Pick up ready tasks → enforce concurrency → dispatch Workers |
| **WorkerAgent** | `worker` | Ephemeral (one per task) | Execute a single task via Engine MCP → report result → self-destruct |
| **TaskStatusRecorder** | `recorder` | Passive (no loop) | Task state machine + JSON file persistence |

## Source layout

```
src/
├── index.ts                    # barrel — re-exports plugin + all building blocks
├── openclaw-plugin.ts          # OpenClaw plugin entry (service + 8 tools)
├── config-manager.ts           # YAML config loader with ${ENV_VAR} substitution
├── master/
│   ├── base-agent.ts           # abstract base: lifecycle, MCP clients, registry
│   ├── head-agent.ts           # observe-think-decide loop
│   ├── scheduler-agent.ts      # task polling & concurrency
│   ├── task-status-recorder.ts # task CRUD & persistence
│   ├── worker-agent.ts         # ephemeral task executor
│   ├── agent-registry.ts       # in-memory agent status (EventEmitter)
│   ├── mcp-server.ts           # standalone MCP server (9 tools via stdio)
│   ├── cli.ts                  # CLI tool (commander)
│   └── __tests__/              # unit tests
├── __tests__/
│   └── e2e.test.ts             # end-to-end test suite (34 tests)
└── types/
    ├── index.ts                # barrel re-export
    ├── agents.ts               # AgentType, AgentStatus, AgentRuntimeStatus, AgentConfig
    ├── tasks.ts                # Task, TaskStatus, MetricsSnapshot, DetectedEvent
    └── models.ts               # PerformanceBenchmark, Deployment, MetricRule
types/
└── openclaw-plugin-sdk.d.ts    # ambient declarations for openclaw/plugin-sdk
```

## Key data flows

### 1. Plugin startup (inside OpenClaw)

```
openclaw-plugin.ts  start(ctx)
  → new AgentRegistry()
  → new TaskStatusRecorder(ctx.stateDir + '/pimclaw-tasks')
  → recorder.initialize()          # loads tasks.json, expires stale tasks
  → new SchedulerAgent(registry, recorder)
  → scheduler.initialize()         # registers in registry, connects MCP
  → scheduler.run()                # background: polls every 5s
  → new HeadAgent(registry, recorder)
  → head.initialize()              # loads persisted snapshots
  → head.run()                     # background: observe-think-decide every 5m
```

### 2. Head Agent observe-think-decide cycle

```
observeMetrics()                   # call Grafana MCP → get ttft, tpot, qps, etc.
  → analyzeSnapshot(snapshot)      # compare consecutive snapshots
  → detect spikes (> 200% change) or drops (< 50% of previous)
  → planTasks(events)              # create tasks in TaskStatusRecorder
                                   # (skip if > 50 active tasks)
  → persistSnapshots()             # write last 5 snapshots to snapshots.json
```

### 3. Task lifecycle

```
ready → scheduling → scheduled → running → done
                                         → failed → (retry: back to ready)
                                                   → (max retries: stays failed)
ready → expired  (if waiting > 60s, or manually revoked)
```

### 4. Tool invocation (from OpenClaw agent session)

```
Agent session: "Scale up gpt-4-prod"
  → OpenClaw calls pimclaw_route_task({ llmDeploymentName: "gpt-4-prod", taskType: "scale-up" })
  → openclaw-plugin.ts creates a Task (status: ready) in TaskStatusRecorder
  → SchedulerAgent picks it up on next poll
  → SchedulerAgent creates a WorkerAgent
  → WorkerAgent calls Engine MCP → reports result
  → Agent session can check with pimclaw_list_tasks or pimclaw_task_counts
```

## Key constants & thresholds

| Where | Constant | Value | What it does |
|-------|----------|-------|--------------|
| HeadAgent | `snapshotInterval` | 5 min | Main observe-think-decide loop |
| HeadAgent | Spike threshold | > 200% | Triggers anomaly event |
| HeadAgent | Drop threshold | < 50% | Triggers anomaly event |
| HeadAgent | `maxSnapshotCopies` | 5 | Sliding window of persisted snapshots |
| HeadAgent | Task capacity | 50 | Skips planning if more active tasks |
| SchedulerAgent | `pollingIntervalMs` | 5 sec | Task polling frequency |
| SchedulerAgent | `maxConcurrentWorkers` | 10 | Worker concurrency cap |
| SchedulerAgent | Task expiry | 60 sec | Ready tasks older than this are expired |
| WorkerAgent | `executionTimeout` | 30 min | `Promise.race` timeout per task |
| TaskStatusRecorder | Ready expiry (init) | 60 sec | Stale ready tasks expired on load |
| TaskStatusRecorder | Scheduling expiry (init) | 30 sec | Stale scheduling tasks expired on load |
| AgentRegistry | Idle threshold | 30 min | Flags head agents as idle |
| AgentRegistry | Error threshold | > 5 | Flags agents with excess errors |

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

The E2E suite (34 tests) covers the full stack without MCP services — HeadAgent uses mock metrics, MCP connection failures are caught gracefully, and SchedulerAgent doesn't use MCP at all.

### CLI inspection

```bash
npx tsx src/master/cli.ts health
npx tsx src/master/cli.ts tasks list --status ready
npx tsx src/master/cli.ts agents list
```

Note: the CLI creates standalone `AgentRegistry` / `TaskStatusRecorder` instances — it does not connect to running agents.

## How to approach changes

### Adding a new tool

1. Add the tool factory function in `src/openclaw-plugin.ts` (follow the `routeTaskTool` pattern)
2. Add it to the `buildPimClawTools()` return array
3. Add the tool name to `openclaw.plugin.json` → `contracts.tools`
4. Optionally mirror it in `src/master/mcp-server.ts` for standalone MCP use
5. Add a test in `src/__tests__/e2e.test.ts` under "Plugin tool flows"

### Changing agent behavior

| What | Start here |
|------|-----------|
| Anomaly detection thresholds | `src/master/head-agent.ts` → `analyzeSnapshot()` |
| Polling interval or concurrency | `src/master/scheduler-agent.ts` (constructor / field defaults) |
| Task state transitions | `src/master/task-status-recorder.ts` → `updateTaskStatus()` |
| Task execution / MCP calls | `src/master/worker-agent.ts` → `executeTask()` |
| Agent registration / health | `src/master/agent-registry.ts` |

### Wiring ConfigurationManager to agents

`ConfigurationManager` is implemented but **not yet wired** into agent constructors. Agents currently hardcode their MCP service configs and thresholds. To activate config-driven setup:

1. Load config in `openclaw-plugin.ts` → `start()` before creating agents
2. Pass `config.agents.head`, `config.agents.scheduler`, etc. into constructors
3. Replace hardcoded MCP service definitions in `HeadAgent` / `WorkerAgent` with `config.mcp.services`

### Adding a new agent type

1. Add the type to `AgentType` in `src/types/agents.ts`
2. Create a new class extending `BaseAgent` in `src/master/`
3. Implement `run()` with the agent's main loop
4. Instantiate and start it in `openclaw-plugin.ts` → `start()` (and shut down in `stop()`)
5. Add relevant counters to `AgentCounters` in `src/types/agents.ts`
6. Write tests

## Testing strategy

| Layer | Tests | Location |
|-------|-------|----------|
| E2E (full stack) | 34 tests across 9 groups | `src/__tests__/e2e.test.ts` |
| AgentRegistry | unit tests | `src/master/__tests__/agent-registry.test.ts` |
| SchedulerAgent | unit tests | `src/master/__tests__/scheduler-agent.test.ts` |
| TaskStatusRecorder | unit tests | `src/master/__tests__/task-status-recorder.test.ts` |

E2E tests run against real classes with no mocks — MCP services fail gracefully, so the entire orchestration flow is testable without external dependencies.

To run all tests: `npm test`  
To run with coverage: `npm run test:coverage`

## Persistence

All persistent state lives under `stateDir` (provided by OpenClaw) or the configured `storagePath`:

```
<stateDir>/
  pimclaw-tasks/
    tasks.json              # all task records
  pimclaw-head-data/
    snapshots.json          # last N metrics snapshots
```

Both files are plain JSON and are read on startup (`initialize()`) and written on shutdown (`persist()`). The task recorder also writes periodically during operation.

## MCP integration boundary

PimClaw acts as both an **MCP client** (agents call external tools) and an **MCP server** (exposes its own tools).

### As MCP client (outbound)

Handled in `BaseAgent.connectToMCPServices()` using `@modelcontextprotocol/sdk`:

| Agent | MCP Service | Tool called |
|-------|-------------|-------------|
| HeadAgent | `grafana` | Metrics collection |
| HeadAgent | `perf` | Benchmark data |
| HeadAgent | `simulator` | Load simulation |
| WorkerAgent | `engine` | `execute_deployment_change` |

Connection failures are caught — agents continue running with fallback behavior.

### As MCP server (inbound)

`PimClawMCPServer` in `src/master/mcp-server.ts` exposes 9 tools over stdio for external frameworks that want to interact with PimClaw without going through OpenClaw.

## Known constraints

- MCP service endpoints are hardcoded in agent constructors (`ConfigurationManager` is not yet wired in)
- The CLI creates fresh instances rather than connecting to a running system
- Worker Agent creation in the Scheduler is partially stubbed (tracks `activeWorkers` but full Worker spawn is TODO)
- `Deployment.kubeernetesPodName` has a typo in `src/types/models.ts`
- OpenClaw SDK types are ambient declarations — PimClaw can be built without the OpenClaw host checkout

## Recommended reading order

1. This guide
2. `src/openclaw-plugin.ts` — the real entry point; shows how everything boots
3. `src/master/base-agent.ts` — lifecycle pattern shared by all agents
4. `src/master/head-agent.ts` — the intelligence center
5. `src/master/scheduler-agent.ts` — task dispatch
6. `src/master/task-status-recorder.ts` — state machine
7. `src/types/tasks.ts` — data shapes
8. `src/__tests__/e2e.test.ts` — see all features exercised
9. `docs/howtointegratewithopenclaw.md` — plugin integration guide
10. `docs/install.md` — build, package, deliver