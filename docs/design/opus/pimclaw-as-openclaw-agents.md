# Pimclaw as OpenClaw Agents — Analysis & Design

## Table of Contents

1. [Project Abstractions](#1-project-abstractions)
2. [Pimclaw–OpenClaw Relationship](#2-pimclaw–openclaw-relationship)
3. [Agent Comparison](#3-agent-comparison)
4. [OpenClaw Agent & Sub-Agent Features](#4-openclaw-agent--sub-agent-features)
5. [OpenClaw Plugin Features](#5-openclaw-plugin-features)
6. [Feasibility: Pimclaw as OpenClaw Agents](#6-feasibility-pimclaw-as-openclaw-agents)
7. [Proposed Agent Architecture](#7-proposed-agent-architecture)
8. [Ability Mapping](#8-ability-mapping)
9. [Design Patterns](#9-design-patterns)
10. [Gaps & Risks](#10-gaps--risks)
11. [Recommendation](#11-recommendation)

---

## 1. Project Abstractions

### Pimclaw — LLM Deployment Orchestration System

**Core Abstraction:** A multi-agent coordination layer that monitors LLM deployments via Grafana metrics, detects anomalies, and schedules corrective actions via external engine APIs.

| Concept | Description |
|---------|-------------|
| **Observe-Think-Decide** | Head agent collects metrics → detects spikes/drops → creates tasks |
| **Task State Machine** | 7-state lifecycle: ready → scheduling → scheduled → running → done/failed/expired |
| **Concurrency Control** | Scheduler enforces max worker slots, polls for ready tasks |
| **Ephemeral Execution** | Workers live only for their task, report result, and die |
| **Persistent State** | Tasks survive restarts via JSON persistence |
| **Recovery** | Stale task detection on startup (ready >60s, scheduling >30s → expired) |
| **Registry** | EventEmitter-based in-memory status tracking for all agents |

**Agents are programmatic** — they are TypeScript classes with `run()` loops, not LLM inference agents.

### OpenClaw — Multi-Channel Personal AI Framework

**Core Abstraction:** A gateway-based personal AI that runs locally, connects to 25+ messaging platforms, and uses LLM inference with 50+ tools.

| Concept | Description |
|---------|-------------|
| **LLM Agent Loop** | Model inference → tool calls → response streaming |
| **Plugin Capabilities** | Providers, channels, tools, hooks, services |
| **Sub-Agent Spawning** | `sessions_spawn` creates child agents with isolated contexts |
| **Cron Scheduling** | Full cron expressions for periodic agent execution |
| **Session Persistence** | File-based transcripts, subagent run recovery |
| **Queue & Lanes** | Session-lane serialization, global concurrency cap |
| **Tool Ecosystem** | 50+ built-in tools + plugin-registered tools |

**Agents are LLM-based** — they are model inference loops with tool access, not programmatic loops.

---

## 2. Pimclaw–OpenClaw Relationship

### Current State: Plugin Model

```
┌─────────────────────────────────────────────┐
│                  OPENCLAW                    │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │         PIMCLAW PLUGIN                │  │
│  │                                       │  │
│  │  Service (lifecycle-managed)          │  │
│  │  ├─ TaskStatusRecorder               │  │
│  │  ├─ SchedulerAgent (loop every 5s)   │  │
│  │  ├─ HeadAgent (loop every 5min)      │  │
│  │  └─ WorkerAgents (ephemeral)         │  │
│  │                                       │  │
│  │  8 Tools (exposed to OpenClaw)        │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Agent Loop (pi-agent-core)                 │
│  └─ can call pimclaw_* tools                │
└─────────────────────────────────────────────┘
```

**Key Boundary:** Pimclaw runs its own internal agent system _inside_ the OpenClaw process but _outside_ the OpenClaw agent loop. The OpenClaw LLM agent interacts with Pimclaw only through the 8 exposed tools.

### Proposed State: Agent Model

```
┌─────────────────────────────────────────────────┐
│                   OPENCLAW                       │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │        HEAD AGENT (LLM, cron-triggered) │    │
│  │  - Observes Grafana metrics             │    │
│  │  - Detects anomalies via reasoning      │    │
│  │  - Creates tasks, spawns scheduler      │    │
│  └───────────┬─────────────────────────────┘    │
│              │ sessions_spawn                    │
│  ┌───────────▼─────────────────────────────┐    │
│  │     SCHEDULER AGENT (LLM, subagent)     │    │
│  │  - Reviews pending tasks                │    │
│  │  - Prioritizes and assigns              │    │
│  │  - Spawns workers, tracks completion    │    │
│  └───────────┬─────────────────────────────┘    │
│              │ sessions_spawn (×N)               │
│  ┌───────────▼─────────────────────────────┐    │
│  │      WORKER AGENTS (LLM, ephemeral)     │    │
│  │  - Execute deployment changes           │    │
│  │  - Report results back                  │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  Task Status Recorder (Plugin Service + Tools)   │
│  - Persistent task CRUD                          │
│  - State machine enforcement                     │
│  - Query interface for agents                    │
└─────────────────────────────────────────────────┘
```

---

## 3. Agent Comparison

### Fundamental Paradigm Difference

| Dimension | Pimclaw Agents | OpenClaw Agents |
|-----------|---------------|-----------------|
| **Runtime** | Programmatic (TypeScript class loops) | LLM inference (model + tools) |
| **Decision Making** | Hardcoded rules (threshold-based) | LLM reasoning (prompt-based) |
| **Lifecycle** | Long-running `while(true)` loops | Request-response or cron-triggered |
| **Communication** | Direct method calls within process | Message-passing via session events |
| **State** | In-memory registry + JSON persistence | Session transcripts + disk persistence |
| **Concurrency** | Code-managed (activeWorkers set) | Platform-managed (queue lanes) |
| **Spawning** | `new WorkerAgent()` constructor | `sessions_spawn` tool call |
| **Error Handling** | try/catch + retry counter | LLM can reason about failures |
| **Observability** | EventEmitter registry | Session transcripts + subagent status |

### Agent-by-Agent Comparison

| Pimclaw Agent | Role | OpenClaw Equivalent | Mapping Feasibility |
|---------------|------|---------------------|---------------------|
| **Head Agent** | Observe metrics, detect anomalies, create tasks | Cron-triggered LLM agent with Grafana MCP access | ✅ **Natural fit** — LLM excels at pattern recognition |
| **Scheduler Agent** | Poll ready tasks, enforce concurrency, spawn workers | LLM agent spawned by Head, manages task queue | ⚠️ **Moderate fit** — deterministic logic mapped to prompts |
| **Task Status Recorder** | CRUD + persistence + state machine | Plugin service + tools (NOT an agent) | ✅ **Best as plugin/tools** — too deterministic for LLM |
| **Worker Agent** | Execute single task via MCP | Ephemeral subagent with MCP tool access | ✅ **Natural fit** — isolated task execution |

---

## 4. OpenClaw Agent & Sub-Agent Features

### Agent Capabilities Relevant to Pimclaw

| Feature | Details | Pimclaw Use |
|---------|---------|-------------|
| **Cron scheduling** | Full cron expressions, isolated agent turns | Head Agent periodic observation |
| **Sub-agent spawning** | `sessions_spawn` with task, model, timeout | Scheduler → Worker dispatching |
| **Persistent state** | Subagent runs persisted to disk, restored on restart | Task tracking survival |
| **Lifecycle events** | `onSubagentStarted`, `onSubagentEnded`, error hooks | Worker completion detection |
| **Announcement system** | Child agents report completion to parent as messages | Worker → Scheduler result delivery |
| **Orphan recovery** | Detects killed subagents on restart | Worker crash recovery |
| **Timeout control** | Per-spawn timeout (default 48h, configurable) | Worker execution timeouts |
| **Context inheritance** | Workspace, tools, attachments passed to children | Task data passing |
| **Concurrency limits** | 4 main agents, 8 subagents per agent | Worker slot management |

### Constraints to Consider

| Constraint | Value | Impact on Pimclaw Design |
|-----------|-------|--------------------------|
| Default subagent depth | 1 (no nested spawning) | Workers cannot spawn sub-workers unless increased |
| Subagent concurrency | 8 per parent | Maps well to Pimclaw's default 10 max workers |
| Announce hard expiry | 2 hours | Long-running tasks need timeout consideration |
| Context window | 16K–200K tokens depending on model | Scheduler must manage task list within context |
| Cron granularity | Standard cron (min 1 minute) | Head's 5-minute interval works perfectly |

---

## 5. OpenClaw Plugin Features

### What Plugins Can Provide

| Capability | API | Current Pimclaw Use |
|------------|-----|---------------------|
| **Tools** | `api.registerTool(tool)` | 8 tools for task management and observability |
| **Services** | `api.registerService({start, stop})` | Lifecycle-managed agent coordination |
| **Hooks** | `before_tool_call`, `after_tool_call`, etc. | Not currently used |
| **Providers** | `api.registerProvider()` | Not applicable |
| **Channels** | `api.registerChannel()` | Not applicable |

### Plugin vs. Agent: When to Use Each

| Use Plugin When... | Use Agent When... |
|-------------------|-------------------|
| Deterministic state machine (task CRUD) | Decision-making benefits from reasoning |
| High-frequency polling (every 5s) | Periodic analysis (every 5min) |
| Need to expose tools to other agents | Need to use tools from other agents |
| Infrastructure/plumbing code | Task execution requiring judgment |
| No LLM inference needed | Complex pattern recognition |

---

## 6. Feasibility: Pimclaw as OpenClaw Agents

### Verdict: **YES — Feasible with a hybrid approach**

The proposed architecture is feasible, but the optimal design uses a **hybrid model** where:
- **Head, Scheduler, and Workers** become OpenClaw LLM agents
- **Task Status Recorder** remains a plugin service exposing tools

### Why Hybrid?

The Recorder is a pure state machine — its operations (create task, update status, persist to disk) are entirely deterministic. Making it an LLM agent would add latency and cost with zero benefit. As plugin-provided tools, all three agent types can call Recorder operations directly.

### Feasibility Assessment by Component

| Component | As Agent? | Confidence | Rationale |
|-----------|-----------|------------|-----------|
| **Head Agent** | ✅ Yes | High | Anomaly detection is a reasoning task. LLM can analyze metric trends, detect subtle patterns, and make nuanced decisions about task creation. Cron scheduling maps perfectly to the 5-minute observation cycle. |
| **Scheduler Agent** | ✅ Yes (with caveats) | Medium | Task prioritization and worker assignment can benefit from reasoning, but the core polling loop and concurrency enforcement need careful prompt engineering. Risk: LLM may make inconsistent scheduling decisions. |
| **Worker Agent** | ✅ Yes | High | Ephemeral execution of a single task via MCP tools is exactly what OpenClaw subagents do. Workers gain the ability to reason about execution failures and adapt. |
| **Task Recorder** | ❌ No (plugin) | High | Pure CRUD + state machine. No reasoning needed. Better as deterministic code with tool interfaces. |

---

## 7. Proposed Agent Architecture

### Architecture Overview

```
OPENCLAW PLATFORM
│
├─ [Plugin] pimclaw-recorder
│   ├─ Service: TaskStatusRecorder (persistent, lifecycle-managed)
│   └─ Tools:
│       ├─ pimclaw_create_task
│       ├─ pimclaw_update_task_status
│       ├─ pimclaw_get_task / pimclaw_list_tasks
│       ├─ pimclaw_task_counts
│       ├─ pimclaw_retry_task
│       ├─ pimclaw_revoke_task
│       └─ pimclaw_health
│
├─ [Agent] pimclaw-head (cron: */5 * * * *)
│   ├─ Model: claude-sonnet (cost-efficient for periodic analysis)
│   ├─ Tools: Grafana MCP, pimclaw_create_task, pimclaw_task_counts
│   ├─ Behavior:
│   │   1. Call Grafana MCP → get metrics snapshot
│   │   2. Analyze for anomalies (LLM reasoning)
│   │   3. Check task capacity (pimclaw_task_counts)
│   │   4. Create tasks for detected issues (pimclaw_create_task)
│   │   5. Spawn Scheduler if tasks created (sessions_spawn)
│   └─ Prompt: System prompt with metric thresholds, history context
│
├─ [Agent] pimclaw-scheduler (spawned by Head)
│   ├─ Model: claude-sonnet
│   ├─ Tools: pimclaw_list_tasks, pimclaw_update_task_status,
│   │         sessions_spawn, subagents
│   ├─ Behavior:
│   │   1. Get ready tasks (pimclaw_list_tasks status=ready)
│   │   2. Check active workers (subagents tool)
│   │   3. Prioritize tasks by severity + age
│   │   4. Spawn Worker subagents for selected tasks
│   │   5. Wait for Worker announcements
│   │   6. Update task status based on results
│   └─ Concurrency: Respects platform max subagent limit (8)
│
└─ [Agent] pimclaw-worker (spawned by Scheduler, ephemeral)
    ├─ Model: claude-haiku (fast, cheap for execution)
    ├─ Tools: Engine MCP (execute_deployment_change),
    │         pimclaw_update_task_status
    ├─ Behavior:
    │   1. Receive task via spawn parameters
    │   2. Update task status → running
    │   3. Execute deployment change via Engine MCP
    │   4. Update task status → done / failed
    │   5. Announce completion to Scheduler
    └─ Timeout: 30 minutes per task
```

### Agent Definitions (AGENTS.md format)

```yaml
# pimclaw-head
name: PimClaw Head
description: >
  Observes LLM deployment metrics via Grafana, detects performance anomalies
  (TTFT spikes, throughput drops, error rate increases), and creates remediation
  tasks. Runs on a 5-minute cron schedule.
model: anthropic/claude-sonnet-4-6
skills: []
thinking: enabled
cron: "*/5 * * * *"
subagents:
  maxDepth: 2    # Head → Scheduler → Workers
  maxConcurrent: 1

# pimclaw-scheduler
name: PimClaw Scheduler
description: >
  Reviews pending deployment tasks, prioritizes by severity and age,
  and dispatches worker agents to execute changes. Manages worker
  concurrency and handles completion/failure reporting.
model: anthropic/claude-sonnet-4-6
thinking: enabled
subagents:
  maxDepth: 1    # Scheduler → Workers
  maxConcurrent: 8

# pimclaw-worker
name: PimClaw Worker
description: >
  Executes a single deployment change (scale-up, scale-down, restart)
  via the Engine MCP service. Reports result and cleans up.
model: anthropic/claude-3-5-haiku
thinking: disabled
timeoutSeconds: 1800
```

### Task State Machine (Preserved)

The 7-state task lifecycle remains identical — it's enforced by the plugin-level Recorder, not by agents:

```
ready ──(Scheduler picks up)──> scheduling ──(Worker spawned)──> scheduled
  ──(Worker starts)──> running ──┬──> done
                                  ├──> failed
                                  └──> expired
```

---

## 8. Ability Mapping

### Pimclaw Feature → OpenClaw Agent Mechanism

| Pimclaw Feature | Current Implementation | OpenClaw Agent Mechanism |
|-----------------|----------------------|--------------------------|
| **5-minute observation cycle** | `setInterval` in HeadAgent.run() | Cron job: `*/5 * * * *` |
| **Metrics collection** | `callMCPTool('grafana', ...)` | Agent calls Grafana MCP tool directly |
| **Anomaly detection** | Hardcoded thresholds (>200% spike, <50% drop) | LLM reasoning with threshold guidelines in prompt |
| **Task creation** | `recorder.createTask()` direct call | Agent calls `pimclaw_create_task` tool |
| **Task polling** | `recorder.getTasksByStatus('ready')` in loop | Agent calls `pimclaw_list_tasks` tool |
| **Worker spawning** | `new WorkerAgent(task)` | `sessions_spawn` with task in description |
| **Concurrency control** | `activeWorkers.size < maxConcurrent` | Platform-enforced `maxConcurrent: 8` |
| **Task data passing** | Constructor parameter | Spawn attachments or task description |
| **Worker result reporting** | `recorder.updateTaskResult()` | Worker calls `pimclaw_update_task_status` tool |
| **Worker completion** | Callback to scheduler | Subagent announcement message |
| **Retry logic** | `recorder.resetTaskForRetry()` | Scheduler calls `pimclaw_retry_task` tool |
| **Stale task cleanup** | Startup recovery in Recorder.initialize() | Plugin service startup (unchanged) |
| **Health reporting** | `registry.getHealthReport()` | `pimclaw_health` tool (unchanged) |
| **Agent status tracking** | AgentRegistry EventEmitter | Subagent registry + `subagents` tool |

### What LLM Agents Gain Over Programmatic Agents

| Capability | Programmatic (Current) | LLM Agent (Proposed) |
|------------|----------------------|----------------------|
| **Anomaly detection** | Fixed thresholds only | Understands context, correlations, seasonal patterns |
| **Task prioritization** | Simple priority field | Can reason about urgency, dependencies, risk |
| **Failure diagnosis** | Error code matching | Can read error messages, suggest remediation |
| **Adaptive behavior** | Requires code changes | Prompt changes adjust behavior |
| **Multi-metric correlation** | Not implemented | LLM can correlate TTFT + throughput + errors |
| **Escalation** | Not implemented | LLM can decide to alert human |

### What LLM Agents Lose

| Capability | Programmatic (Current) | LLM Agent (Proposed) |
|------------|----------------------|----------------------|
| **Determinism** | Same input → same output | Non-deterministic reasoning |
| **Speed** | Milliseconds per cycle | Seconds per inference |
| **Cost** | Zero marginal cost | Per-token inference cost |
| **Reliability** | No hallucination risk | Possible incorrect decisions |
| **Latency** | Sub-second task scheduling | Seconds for scheduling decisions |
| **Continuous polling** | Every 5 seconds | Minimum cron: every 1 minute |

---

## 9. Design Patterns

### Pattern 1: Cron-Triggered Observer (Head Agent)

The Head Agent maps naturally to OpenClaw's cron system:

```
Cron fires (every 5 min)
  → Agent starts with system prompt containing:
      - Role description
      - Metric analysis guidelines
      - Anomaly thresholds
      - Recent snapshot history (via session persistence)
  → Agent calls Grafana MCP tools
  → Agent reasons about metrics
  → Agent calls pimclaw_create_task for anomalies
  → Agent spawns Scheduler if tasks created
  → Agent completes, session preserved for next run
```

**Prompt-based thresholds replace code-based thresholds:**
```
## Anomaly Detection Guidelines
- TTFT increase >200% from previous snapshot: HIGH severity spike
- TTFT decrease >50%: MEDIUM severity (possible capacity waste)
- Error rate >5%: HIGH severity
- Throughput drop >30%: MEDIUM severity
- Use your judgment for patterns not covered above
```

### Pattern 2: Cascade Spawning (Head → Scheduler → Workers)

```
Head Agent (cron)
  │
  ├─ sessions_spawn(
  │    task: "Schedule and execute N pending tasks",
  │    agentId: "pimclaw-scheduler",
  │    mode: "run",
  │    runTimeoutSeconds: 3600
  │  )
  │
  └─ Scheduler Agent (subagent of Head)
       │
       ├─ sessions_spawn(task: "Execute scale-up for deployment X", ...)
       ├─ sessions_spawn(task: "Execute restart for deployment Y", ...)
       └─ ... up to maxConcurrent workers
```

**Depth Requirement:** `maxDepth: 2` (Head → Scheduler → Workers). The default is 1, so this **must** be configured.

### Pattern 3: Plugin-as-Infrastructure (Recorder)

The Recorder plugin provides the shared state layer that all agents access through tools:

```
┌──────────────────────────────────────────┐
│  pimclaw-recorder (Plugin Service)       │
│                                          │
│  TaskStatusRecorder                      │
│  ├─ tasks.json (persistent)              │
│  ├─ State machine enforcement            │
│  ├─ Recovery on startup                  │
│  └─ Exposed via 7 tools:                │
│     ├─ pimclaw_create_task              │
│     ├─ pimclaw_update_task_status       │
│     ├─ pimclaw_get_task                 │
│     ├─ pimclaw_list_tasks              │
│     ├─ pimclaw_task_counts             │
│     ├─ pimclaw_retry_task              │
│     └─ pimclaw_revoke_task             │
│                                          │
│  All agents call these tools as needed   │
└──────────────────────────────────────────┘
```

### Pattern 4: Stateful Sessions (Snapshot History)

The Head Agent maintains observational continuity across cron runs via session persistence:

```
Run 1 (t=0min):  Collect snapshot → No anomaly → Session saved
Run 2 (t=5min):  Load session context → Collect snapshot → Compare with Run 1 → Detect spike
Run 3 (t=10min): Load session context → Collect snapshot → Spike resolved → No action
```

OpenClaw sessions persist between cron runs by default. The Head Agent's session transcript accumulates historical observations, enabling trend detection without external state storage.

---

## 10. Gaps & Risks

### Gap 1: Polling Frequency

**Pimclaw Current:** Scheduler polls every 5 seconds for ready tasks.
**OpenClaw Cron:** Minimum granularity is 1 minute.

**Mitigation:** The Scheduler doesn't need to be cron-triggered — it's spawned by the Head Agent when tasks exist. The "polling" becomes event-driven: Head creates tasks → spawns Scheduler → Scheduler processes all ready tasks in one run.

### Gap 2: Subagent Depth

**Default:** `maxDepth: 1` (no nesting).
**Required:** `maxDepth: 2` (Head → Scheduler → Workers).

**Mitigation:** Configure `subagents.maxDepth: 2` in agent config. This is a supported configuration option.

### Gap 3: Deterministic Scheduling Decisions

**Risk:** LLM Scheduler may make inconsistent decisions (scheduling wrong tasks, ignoring priority).

**Mitigation:**
- Strong system prompt with explicit rules
- Task Recorder enforces state machine (invalid transitions rejected)
- Scheduler can only act on tasks the Recorder allows
- Use `thinking: enabled` for reasoning transparency

### Gap 4: Cost

**Risk:** Every 5-minute cron run costs inference tokens.

**Mitigation:**
- Use claude-sonnet for Head/Scheduler (not opus)
- Use claude-haiku for Workers (cheapest, fastest)
- Head Agent short-circuits early if no Grafana changes detected
- Estimated cost: ~$0.50–2.00/day for continuous monitoring

### Gap 5: Context Window Growth

**Risk:** Head Agent session grows unboundedly with snapshot history.

**Mitigation:**
- OpenClaw auto-compaction handles this
- Compaction summarizes older turns
- Keep prompt lean, let compaction manage history

### Gap 6: Failure Atomicity

**Risk:** If Scheduler agent crashes mid-scheduling, tasks may be in inconsistent state.

**Mitigation:**
- Recorder enforces state transitions (scheduling → scheduled only if valid)
- Stale task recovery on startup (scheduling >30s → expired)
- OpenClaw orphan recovery detects killed subagents

---

## 11. Recommendation

### Recommended Approach: Hybrid Architecture

| Component | Implementation | Rationale |
|-----------|---------------|-----------|
| **Task Status Recorder** | Plugin service + tools | Pure state machine, deterministic, no LLM needed |
| **Head Agent** | OpenClaw LLM agent (cron) | Anomaly detection benefits from reasoning |
| **Scheduler Agent** | OpenClaw LLM agent (subagent) | Task prioritization can leverage judgment |
| **Worker Agents** | OpenClaw LLM subagents (ephemeral) | Task execution with adaptive error handling |

### Implementation Order

1. **Phase 1: Recorder Plugin** — Extract and simplify current Recorder into a standalone plugin with clean tool interfaces. This is the foundation all agents depend on.

2. **Phase 2: Worker Agent** — Simplest agent to implement. Single task execution via Engine MCP. Validate the subagent spawning pattern works.

3. **Phase 3: Head Agent** — Implement cron-triggered observation with Grafana MCP. Validate session persistence for snapshot history.

4. **Phase 4: Scheduler Agent** — Most complex agent. Implement task prioritization, worker spawning, and completion tracking. Validate cascade spawning (depth 2).

### Configuration Required

```json
{
  "agents": {
    "agentConfigs": {
      "pimclaw-head": {
        "model": "anthropic/claude-sonnet-4-6",
        "thinking": "enabled",
        "subagents": { "maxDepth": 2, "maxConcurrent": 1 }
      },
      "pimclaw-scheduler": {
        "model": "anthropic/claude-sonnet-4-6",
        "thinking": "enabled",
        "subagents": { "maxDepth": 1, "maxConcurrent": 8 }
      },
      "pimclaw-worker": {
        "model": "anthropic/claude-3-5-haiku",
        "thinking": "disabled",
        "timeoutSeconds": 1800
      }
    }
  }
}
```

### What Changes vs. Current Pimclaw

| Aspect | Current Plugin Model | Proposed Agent Model |
|--------|---------------------|---------------------|
| Anomaly detection | Hardcoded threshold rules | LLM reasoning with prompt-based guidelines |
| Scheduling decisions | Deterministic FIFO + priority | LLM-assisted prioritization |
| Worker execution | Direct MCP call | LLM agent with MCP tool access |
| Polling | 5-second code loop | Event-driven (Head spawns Scheduler) |
| Cost | Zero (code only) | ~$0.50–2.00/day inference cost |
| Adaptability | Requires code changes | Prompt changes adjust behavior |
| Observability | Custom EventEmitter registry | OpenClaw session transcripts + subagent status |
| Recovery | Custom stale-task detection | Plugin Recorder + OpenClaw orphan recovery |

### Final Assessment

**The architecture is feasible.** OpenClaw provides all the primitives needed: cron scheduling, sub-agent spawning with lifecycle management, persistent sessions, configurable concurrency, and a plugin system for deterministic infrastructure. The main design decision — keeping the Recorder as a plugin while making Head/Scheduler/Workers into agents — leverages the strengths of both systems.
