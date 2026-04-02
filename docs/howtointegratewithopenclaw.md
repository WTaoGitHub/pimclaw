# How to Integrate PimClaw with OpenClaw

## What Happens When You Install PimClaw

PimClaw is a standard OpenClaw plugin. When OpenClaw activates it:

1. **Service starts** — the `pimclaw-agents` service boots three background agents inside the OpenClaw process:
   - **Task Status Recorder** — initializes first, recovers persisted tasks and marks stale ones expired
   - **Scheduler Agent** — polls for ready tasks every 5 s, creates Worker Agents (up to 10 concurrent)
   - **Head Agent** — runs the Observe-Think-Decide loop every 5 min, collecting Grafana metrics, detecting anomalies, and planning corrective tasks
2. **Tools appear** — eight tools become available to every OpenClaw agent session (see table below)
3. **Service stops** — when OpenClaw shuts down, agents are stopped in reverse order and task state is persisted

All agent data is stored in OpenClaw's `stateDir` so it survives restarts.

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

After installation, restart or reload OpenClaw — the plugin service starts automatically.

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
│  │  │  Service: pimclaw-agents                      │  │    │
│  │  │                                               │  │    │
│  │  │   start(ctx) ──► TaskStatusRecorder           │  │    │
│  │  │                    ↓                          │  │    │
│  │  │                 SchedulerAgent.run()           │  │    │
│  │  │                    ↓                          │  │    │
│  │  │                 HeadAgent.run()                │  │    │
│  │  │                                               │  │    │
│  │  │   stop(ctx)  ──► Head → Scheduler → persist   │  │    │
│  │  └───────────────────────────────────────────────┘  │    │
│  │                                                     │    │
│  │  Tools: pimclaw_route_task, pimclaw_health, …       │    │
│  └─────────────────────────────────────────────────────┘    │
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
    api.registerService(createPimClawService());  // boots agents

    for (const toolFactory of buildPimClawTools()) {
      api.registerTool(toolFactory);              // exposes tools
    }
  },
});
```

### Service Lifecycle

| Phase   | What happens                                                   |
|---------|----------------------------------------------------------------|
| `start` | Creates `AgentRegistry`, initializes `TaskStatusRecorder` (reads `stateDir/pimclaw-tasks/tasks.json`), starts `SchedulerAgent.run()`, starts `HeadAgent.run()` |
| `stop`  | Calls `head.shutdown()` → `scheduler.shutdown()` → `taskRecorder.persist()` |

Data is persisted under `ctx.stateDir`:

```
<stateDir>/
  pimclaw-tasks/
    tasks.json          # task state
  pimclaw-head-data/
    snapshots.json      # last N metric snapshots
```

---

## Available Tools

Once the plugin is active, any OpenClaw agent can call these tools:

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `pimclaw_route_task` | Submit a task to the Scheduler | `llmDeploymentName`, `taskType`, `priority?`, `taskData?` |
| `pimclaw_list_agents` | List active PimClaw agents | `agentType?` |
| `pimclaw_agent_status` | Detailed status of one agent | `agentId` |
| `pimclaw_health` | System-wide health report | — |
| `pimclaw_task_counts` | Task counts by status | — |
| `pimclaw_list_tasks` | List tasks (optionally filtered) | `status?`, `limit?` |
| `pimclaw_retry_task` | Reset a failed task for retry | `taskId` |
| `pimclaw_revoke_task` | Cancel a pending task | `taskId` |

---

## Using PimClaw from an OpenClaw Agent

### Route a task

The primary interaction — tell PimClaw to do something with a deployment:

```
You: Scale up the gpt-4-prod deployment to handle the traffic spike.
Agent: I'll submit that to PimClaw.
       → pimclaw_route_task({ llmDeploymentName: "gpt-4-prod", taskType: "scale-up", taskData: { reason: "traffic spike" } })
       ← { success: true, taskId: "a1b2c3…", message: "Task routed to scheduler for gpt-4-prod" }
```

### Check health

```
You: How is PimClaw doing?
Agent: → pimclaw_health()
       ← { totalAgents: 3, healthyAgents: 3, issues: [] }
       All three agents are healthy with no issues.
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

### List agents

```
You: Show me all PimClaw agents.
Agent: → pimclaw_list_agents()
       ← [{ agentId: "head-1", agentType: "head", status: "Listening" },
          { agentId: "scheduler-1", agentType: "scheduler", status: "Listening" }]
```

### Get task counts

```
You: How many tasks are queued?
Agent: → pimclaw_task_counts()
       ← { ready: 3, scheduling: 0, scheduled: 1, running: 2, done: 15, failed: 1, expired: 0 }
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
    "properties": {}
  },
  "contracts": {
    "tools": [
      "pimclaw_route_task",
      "pimclaw_list_agents",
      "pimclaw_agent_status",
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

The Head Agent connects to three external MCP services at startup.  
By default the connection commands are hardcoded in the `HeadAgent` constructor:

| MCP Service | Default Command | Purpose |
|-------------|-----------------|----------|
| `grafana` | `node path/to/grafana-mcp-server.js` | Collect LLM deployment metrics |
| `perf` | `node path/to/perf-mcp-server.js` | Performance benchmarking data |
| `simulator` | `python path/to/simulator-mcp-server.py` | Traffic / load simulation |

To override these, supply a `pimclaw.config.yaml` (see [design docs](./design.md) for the full schema):

```yaml
version: "1.0"
agents:
  head:
    snapshotInterval: 300000      # observe-think-decide cycle (ms)
  scheduler:
    maxConcurrentWorkers: 10
    pollingIntervalMs: 5000
mcp:
  services:
    grafana:
      command: node
      args: [/opt/mcp/grafana-mcp-server.js]
    perf:
      command: node
      args: [/opt/mcp/perf-mcp-server.js]
    simulator:
      command: python3
      args: [/opt/mcp/simulator-mcp-server.py]
storage:
  path: ./pimclaw-data
  type: file
logging:
  level: info
  format: json
```

Environment variable substitution is supported in YAML values using `${VAR_NAME}` syntax.

> **Note:** If the MCP services are not available at startup, the Head Agent logs connection errors and continues running — it will use mock / fallback metrics until real services are connected.

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

### Agents not starting

Check the OpenClaw logs for `[PimClaw]` messages:

```
[PimClaw] Starting agents…
[PimClaw] All agents started (TaskRecorder → Scheduler → Head)
```

If you see `[PimClaw] Scheduler error:` or `[PimClaw] Head error:`, the MCP services may not be reachable.  
The agents will still run — MCP connection failures are caught and logged, and the Head Agent falls back to mock metrics.

### Tools return "PimClaw service not running"

This means the `pimclaw-agents` service failed to start or hasn't started yet.  
Verify the manifest lists the tools in `contracts.tools` and that the service lifecycle completed without errors.

### Tasks stuck in "scheduling"

The Scheduler marks tasks stuck in `scheduling` for > 60 s as `expired`.  
If tasks keep expiring, check Worker Agent creation and MCP service connectivity.

---

## Architecture Summary

| Component | Role | Lifecycle |
|-----------|------|-----------|
| **AgentRegistry** | In-memory status of all agents, health monitoring, event emission | Created on service `start`, dropped on `stop` |
| **TaskStatusRecorder** | Persistent task state machine (JSON file in `stateDir`) | Initialized on `start`, flushed on `stop` |
| **SchedulerAgent** | Polls ready tasks, enforces concurrency (max 10 workers), creates Workers | `run()` on `start`, `shutdown()` on `stop` |
| **HeadAgent** | Observe-Think-Decide loop every 5 min — collects metrics, detects anomalies, plans tasks | `run()` on `start`, `shutdown()` on `stop` |
| **WorkerAgent** | Ephemeral — executes a single task via Engine MCP, then disposes | Created by Scheduler per task |
