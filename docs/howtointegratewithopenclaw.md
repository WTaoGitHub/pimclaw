# How to Integrate PimClaw with OpenClaw

## What Happens When You Install PimClaw

PimClaw is a standard OpenClaw plugin using a **v2 hybrid architecture**: two external LLM agents (Head + Planner) handle anomaly detection and configuration planning, while deterministic components inside the plugin handle task scheduling and execution.

When OpenClaw activates the plugin:

1. **Service starts** — the `pimclaw-components` service boots the in-plugin components:
   - **Task Status Recorder** — initializes first, recovers persisted tasks and marks stale ones expired (including `planning` tasks >10 min → expired)
   - **AnomalyReceiver** — validates incoming anomaly events from the LLM Head Agent, triggers PlannerTrigger per event
   - **Scheduler** — polls for ready tasks every 5 s, creates Workers (up to 10 concurrent)
2. **Tools appear** — ten tools become available to every OpenClaw agent session (see table below)
3. **LLM agents run externally** — the Head Agent (cron `*/5 * * * *`) and Planner Agent (on-demand) run via OpenClaw's agent runtime, not inside the plugin. They interact through two integration gates: `pimclaw_submit_anomalies` and `pimclaw_plan_task`.
4. **Service stops** — when OpenClaw shuts down, components are stopped in reverse order, fallback timers are cleared, and task state is persisted

All task data is stored in OpenClaw's `stateDir` so it survives restarts. LLM agent sessions are managed by OpenClaw's agent runtime.

---

## Installation

### Option A — Install from a local path

```bash
openclaw plugin add /path/to/pimclaw
```

### Option B — Install from npm

```bash
openclaw plugin add pimclaw
```

### Option C — Reference in your OpenClaw config

Add PimClaw to the `plugins` array in your OpenClaw configuration file (`openclaw.json` or equivalent):

```json
{
  "plugins": [
    { "id": "pimclaw", "enabled": true }
  ]
}
```

### Option D — Install into a Docker container

If OpenClaw runs inside Docker, copy the plugin source into the container and link it:

```bash
# Copy the plugin into the container
docker cp /path/to/pimclaw openclaw-container:/tmp/pimclaw

# Install production dependencies inside the container
docker exec openclaw-container sh -c 'cd /tmp/pimclaw && npm install --production'

# Register the plugin with --link so changes take effect immediately
docker exec openclaw-container openclaw plugin add --link /tmp/pimclaw

# Enable the plugin
docker exec openclaw-container openclaw plugin enable pimclaw
```

After installation, restart or reload OpenClaw — the plugin service starts automatically and the LLM agents begin their cron schedules.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  OpenClaw Process                                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  PimClaw Plugin  (definePluginEntry)                 │    │
│  │                                                     │    │
│  │  ┌───────────────────────────────────────────────┐  │    │
│  │  │  Service: pimclaw-components                  │  │    │
│  │  │                                               │  │    │
│  │  │   start(ctx) ──► TaskStatusRecorder           │  │    │
│  │  │                    ↓                          │  │    │
│  │  │                 AnomalyReceiver               │  │    │
│  │  │                   (+ PlannerTrigger)           │  │    │
│  │  │                    ↓                          │  │    │
│  │  │                 Scheduler.run()                │  │    │
│  │  │                    ↓                          │  │    │
│  │  │                 Workers (ephemeral)            │  │    │
│  │  │                                               │  │    │
│  │  │   stop(ctx)  ──► Scheduler → timers → persist │  │    │
│  │  └───────────────────────────────────────────────┘  │    │
│  │                                                     │    │
│  │  Tools: pimclaw_submit_anomalies, pimclaw_health, … │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  LLM Agent Runtime (external to plugin)                     │
│    [pimclaw-head]     cron */5 min → pimclaw_submit_anomalies│
│    [pimclaw-planner]  on-demand    → pimclaw_plan_task       │
│                                                             │
│  Agent Sessions                                             │
│    "Check PimClaw health"  ──► calls pimclaw_health tool    │
│    "Scale up gpt-4"        ──► calls pimclaw_route_task     │
└─────────────────────────────────────────────────────────────┘
```

### Plugin Entry Point

```typescript
// src/openclaw-plugin.ts
export default definePluginEntry({
  id: 'pimclaw',
  name: 'PimClaw',
  description: 'LLM deployment orchestration …',

  register(api) {
    api.registerService(createPimClawService());  // boots components

    for (const toolFactory of buildPimClawTools()) {
      api.registerTool(toolFactory);              // exposes tools
    }
  },
});
```

### Service Lifecycle

| Phase   | What happens                                                   |
|---------|----------------------------------------------------------------|
| `start` | Creates `ComponentRegistry`, initializes `TaskStatusRecorder` (reads `stateDir/pimclaw-tasks/tasks.json`), creates `PlannerTrigger` + `AnomalyReceiver` with fallback hooks, starts `Scheduler.run()` |
| `stop`  | Calls `scheduler.shutdown()` → clears planning fallback timers → `taskRecorder.persist()` |

Data is persisted under `ctx.stateDir`:

```
<stateDir>/
  pimclaw-tasks/
    tasks.json          # task state
```

---

## Available Tools

Once the plugin is active, any OpenClaw agent can call these tools:

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `pimclaw_submit_anomalies` | Submit detected anomaly events (Head Agent → Plugin) | `events[]` |
| `pimclaw_plan_task` | Submit deployment config plan (Planner Agent → Plugin) | `taskId`, `taskType`, `config`, `reasoning` |
| `pimclaw_route_task` | Submit a task directly (bypasses Head/Planner) | `llmDeploymentName`, `taskType`, `priority?`, `taskData?` |
| `pimclaw_list_components` | List active PimClaw components | `componentType?` |
| `pimclaw_component_status` | Detailed status of one component | `componentId` |
| `pimclaw_health` | System-wide health report | — |
| `pimclaw_task_counts` | Task counts by status | — |
| `pimclaw_list_tasks` | List tasks (optionally filtered) | `status?`, `limit?` |
| `pimclaw_retry_task` | Reset a failed task for retry | `taskId` |
| `pimclaw_revoke_task` | Cancel a pending task | `taskId` |

---

## Using PimClaw from an OpenClaw Agent

### Route a task

The direct interaction — tell PimClaw to do something with a deployment (bypasses the LLM Head/Planner flow):

```
You: Scale up the gpt-4-prod deployment to handle the traffic spike.
Agent: I'll submit that to PimClaw.
       → pimclaw_route_task({ llmDeploymentName: "gpt-4-prod", taskType: "scale-up", taskData: { reason: "traffic spike" } })
       ← { success: true, taskId: "a1b2c3…", message: "Task routed to scheduler for gpt-4-prod" }
```

### The automated flow (LLM Head → Planner → Execution)

Most tasks are created automatically by the LLM Head Agent and planned by the Planner. The flow is:

```
[LLM Head Agent]  detects TTFT spike
  → pimclaw_submit_anomalies({ events: [{ type: "spike", metricName: "ttft", ... }] })
  ← { success: true, accepted: 1, tasks: [{ taskId: "x1y2" }] }

[Plugin]  creates task in "planning" state → triggers Planner Agent

[LLM Planner Agent]  analyzes via Perf MCP + Simulator MCP
  → pimclaw_plan_task({ taskId: "x1y2", taskType: "scale-up", config: { replicas: 3 }, reasoning: "..." })
  ← { success: true, taskId: "x1y2", message: "Task planned and ready for scheduling" }

[Plugin]  transitions task planning → ready → Scheduler picks up → Worker executes
```

If the Planner times out or fails, the plugin automatically applies a fallback plan (default: scale-up by 1 replica).

### Check health

```
You: How is PimClaw doing?
Agent: → pimclaw_health()
       ← { totalAgents: 2, healthyAgents: 2, issues: [] }
       All components are healthy with no issues.
```

### Monitor tasks

```
You: Show me running tasks.
Agent: → pimclaw_list_tasks({ status: "running" })
       ← [{ taskId: "x1y2", llmDeploymentName: "gpt-4-prod", taskType: "scale-up", status: "running" }]
```

### Retry a failed task

```
You: Retry that failed scaling task.
Agent: → pimclaw_retry_task({ taskId: "x1y2" })
       ← { success: true, taskId: "x1y2" }
```

### Revoke a pending task

```
You: Cancel the pending restart for llama-70b.
Agent: → pimclaw_revoke_task({ taskId: "x1y2" })
       ← { success: true, taskId: "x1y2" }
       The task has been cancelled (marked as expired).
```

### List components

```
You: Show me all PimClaw components.
Agent: → pimclaw_list_components()
       ← [{ agentId: "scheduler-1", agentType: "scheduler", status: "Listening" }]
```

> **Note:** The LLM Head and Planner Agents are NOT listed here — they run outside the plugin via OpenClaw's agent runtime. Use OpenClaw's agent/session management to inspect them.

### Get task counts

```
You: How many tasks are queued?
Agent: → pimclaw_task_counts()
       ← { planning: 1, ready: 3, scheduling: 0, scheduled: 1, running: 2, done: 15, failed: 1, expired: 0 }
```

---

## Plugin Manifest

The `openclaw.plugin.json` file declares the plugin identity, config schema, and tool contracts:

```json
{
  "id": "pimclaw",
  "enabledByDefault": false,
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "anomalyReceiver": {
        "type": "object",
        "properties": {
          "maxEventsPerSubmission": { "type": "number", "default": 20 },
          "deduplicationWindowMs": { "type": "number", "default": 600000 },
          "planningTimeoutMs": { "type": "number", "default": 600000 },
          "allowedMetrics": { "type": "array", "items": { "type": "string" } }
        }
      },
      "planner": {
        "type": "object",
        "properties": {
          "agentId": { "type": "string", "default": "pimclaw-planner" },
          "timeoutSeconds": { "type": "number", "default": 600 },
          "fallbackTaskType": { "type": "string", "default": "scale-up" },
          "fallbackConfig": { "type": "object" }
        }
      }
    }
  },
  "contracts": {
    "tools": [
      "pimclaw_submit_anomalies",
      "pimclaw_plan_task",
      "pimclaw_route_task",
      "pimclaw_list_components",
      "pimclaw_component_status",
      "pimclaw_health",
      "pimclaw_task_counts",
      "pimclaw_list_tasks",
      "pimclaw_retry_task",
      "pimclaw_revoke_task"
    ]
  }
}
```

The `package.json` includes OpenClaw compatibility metadata:

```json
{
  "openclaw": {
    "extensions": [
      "./src/openclaw-plugin.ts"
    ],
    "compat": {
      "pluginApi": ">=2026.1.0"
    }
  }
}
```

---

## Configuration

### Plugin Configuration

PimClaw's plugin-level config controls the AnomalyReceiver and Planner integration. Set these in your OpenClaw config under the `pimclaw` plugin:

| Setting | Default | Purpose |
|---------|---------|---------|
| `anomalyReceiver.maxEventsPerSubmission` | 20 | Max events per `pimclaw_submit_anomalies` call |
| `anomalyReceiver.deduplicationWindowMs` | 600000 (10 min) | Ignore duplicate metric+deployment events within this window |
| `anomalyReceiver.planningTimeoutMs` | 600000 (10 min) | How long to wait for Planner before applying fallback |
| `anomalyReceiver.allowedMetrics` | `["ttft", "tpot", "qps", "throughput", "gpu_utilization", "error_rate"]` | Accepted metric names |
| `planner.agentId` | `pimclaw-planner` | OpenClaw agent ID for the Planner |
| `planner.timeoutSeconds` | 600 | Planner agent run timeout |
| `planner.fallbackTaskType` | `scale-up` | Task type used when Planner fails/times out |
| `planner.fallbackConfig` | `{ "replicaDelta": 1 }` | Config applied when Planner fails/times out |

### LLM Agent Configuration

The Head and Planner agents are configured via OpenClaw's agent config, not the plugin config. See `AGENTS.md` for full definitions.

```json
{
  "agents": {
    "agentConfigs": {
      "pimclaw-head": {
        "model": "minimax-m2_1",
        "thinking": "disabled",
        "subagents": { "maxDepth": 0 }
      },
      "pimclaw-planner": {
        "model": "minimax-m2_1",
        "thinking": "enabled",
        "subagents": { "maxDepth": 0 }
      }
    }
  }
}
```

### Optional: Scheduler/Component Configuration

To override Scheduler and component settings, supply a `pimclaw.config.yaml`:

```yaml
version: "1.0"
agents:
  scheduler:
    maxConcurrentWorkers: 10
    pollingIntervalMs: 5000
mcp:
  services:
    engine:
      command: node
      args: [/opt/mcp/engine-mcp-server.js]
storage:
  path: ./pimclaw-data
  type: file
logging:
  level: info
  format: json
```

Environment variable substitution is supported in YAML values using `${VAR_NAME}` syntax.

---

## Troubleshooting

### Plugin doesn't appear

```bash
openclaw plugin list          # verify pimclaw is listed
openclaw plugin enable pimclaw  # if disabled
```

In Docker:

```bash
docker exec openclaw-container openclaw plugin list
docker exec openclaw-container openclaw plugin enable pimclaw
```

### Components not starting

Check the OpenClaw logs for `[PimClaw]` messages:

```
[PimClaw] Starting components…
[PimClaw] Components started (TaskRecorder → AnomalyReceiver → Scheduler)
```

If you see `[PimClaw] Scheduler error:`, the Engine MCP service may not be reachable. The Scheduler will still run — MCP connection failures are caught and logged.

### LLM Head Agent not detecting anomalies

The Head Agent runs externally via OpenClaw's agent runtime. Check:
- OpenClaw cron is configured for `pimclaw-head` at `*/5 * * * *`
- The Grafana MCP service is accessible from the agent's tool list
- The `pimclaw-head-session` session exists and is accumulating turns
- The agent can call `pimclaw_submit_anomalies` and `pimclaw_task_counts`

### Tasks stuck in "planning"

Planning tasks that exceed `planningTimeoutMs` (default 10 min) are automatically promoted to `ready` with the fallback config. If tasks still get stuck:
- Check the Planner agent logs in OpenClaw
- Verify `pimclaw-planner` agent is correctly configured
- On restart, the TaskStatusRecorder expires `planning` tasks >10 min

### Tools return "PimClaw service not running"

This means the `pimclaw-components` service failed to start or hasn't started yet.  
Verify the manifest lists the tools in `contracts.tools` and that the service lifecycle completed without errors.

### Tasks stuck in "scheduling"

The Scheduler marks tasks stuck in `scheduling` for > 60 s as `expired`.  
If tasks keep expiring, check Worker creation and Engine MCP service connectivity.

---

## Architecture Summary

| Component | Role | Lifecycle |
|-----------|------|-----------|
| **ComponentRegistry** | In-memory status of all PimClaw components, health monitoring, event emission | Created on service `start`, dropped on `stop` |
| **TaskStatusRecorder** | Persistent task state machine (JSON file in `stateDir`), 8-state lifecycle including `planning` | Initialized on `start`, flushed on `stop` |
| **AnomalyReceiver** | Validates incoming anomaly events, deduplicates, rate-limits, triggers PlannerTrigger | Created on `start`, dropped on `stop` |
| **PlannerTrigger** | Spawns LLM Planner agent via OpenClaw API per anomaly event | Created on `start`, dropped on `stop` |
| **Scheduler** | Polls for ready tasks, enforces concurrency (max 10 workers), creates Workers | `run()` on `start`, `shutdown()` on `stop` |
| **Worker** | Ephemeral — executes a single task via Engine MCP, then disposes | Created by Scheduler per task |
| **LLM Head Agent** | Cron-triggered (*/5 min), detects anomalies via Grafana, calls `pimclaw_submit_anomalies` | Managed by OpenClaw agent runtime (external) |
| **LLM Planner Agent** | On-demand, plans deployment configs using Perf/Simulator MCP, calls `pimclaw_plan_task` | Managed by OpenClaw agent runtime (external) |
