# PimClaw User Guide

## What Is PimClaw

PimClaw is an **LLM deployment orchestration plugin** for OpenClaw. It autonomously monitors LLM inference services, detects performance anomalies, plans configuration changes, and executes those changes — all through a multi-agent system.

**Key capabilities:**
- Monitors LLM inference metrics via Prometheus (TTFT, TPOT, QPS, throughput, GPU utilization, error rate)
- Detects performance anomalies automatically (spikes, drops, trends)
- Plans optimal deployment configurations using historical data and simulation
- Executes deployment changes (scale up/down, restart, reconfigure)
- Provides operator tools for manual task management

## Installation

### Option 1 — Install from npm

```bash
openclaw plugins install pimclaw
```

### Option 2 — Install from a local path

```bash
openclaw plugins install /path/to/pimclaw
```

### Option 3 — Reference in OpenClaw config

```json
{
  "plugins": [
    { "id": "pimclaw", "enabled": true }
  ]
}
```

### Option 4 — Install into a Docker container

```bash
docker cp /path/to/pimclaw openclaw-container:/app/plugins/pimclaw
docker exec -u root openclaw-container sh -lc 'chown -R node:node /app/plugins/pimclaw'
docker exec openclaw-container sh -lc 'openclaw plugins install /app/plugins/pimclaw'
docker restart openclaw-container
```

### Verify Installation

```bash
openclaw plugins list              # pimclaw should appear
openclaw plugins inspect pimclaw   # pimclaw should be loaded
openclaw plugins doctor            # no plugin issues
```

Once activated, the `pimclaw-components` service starts automatically and all tools become available to agent sessions.

## Configuration

### Plugin Configuration

Set these in your OpenClaw config under the `pimclaw` plugin entry:

| Setting | Default | Purpose |
|---------|---------|---------|
| `prometheus.baseUrl` | — | Prometheus endpoint (required) |
| `prometheus.engine` | all configured | Inference engine: `vllm`, `sglang`, or array |
| `prometheus.queryOverrides` | `{}` | Per-metric PromQL overrides |
| `prometheus.defaultLabels` | `{}` | Extra label matchers for every PromQL query |
| `engineMcp.sseUrl` | — | qianjin-xuntui Engine MCP endpoint (required) |
| `engineMcp.username` | — | Engine MCP auth username (required) |
| `engineMcp.password` | — | Engine MCP auth password (required) |
| `perfMcp.serverScriptPath` | — | Path to perfllm_mcp_server.py (required) |
| `simMcp.sseUrl` | — | Hisim simulation MCP endpoint (required) |
| `anomalyReceiver.maxEventsPerSubmission` | 20 | Max events per `pimclaw_submit_anomalies` call |
| `anomalyReceiver.deduplicationWindowMs` | 600000 | Deduplication window (10 min) |
| `anomalyReceiver.planningTimeoutMs` | 600000 | Planner timeout before fallback (10 min) |
| `planner.agentId` | `pimclaw-planner` | OpenClaw agent ID for the Planner |
| `planner.timeoutSeconds` | 600 | Planner agent run timeout |
| `planner.fallbackTaskType` | `scale-up` | Task type when Planner fails |
| `planner.fallbackConfig` | `{ replicaDelta: 1 }` | Config when Planner fails |
| `headFeedback.settlingDelayMs` | 900000 | Delay after completion before Head feedback (15 min) |
| `headFeedback.feedbackValidityMs` | 3600000 | Max age for Head feedback review (1 hour) |

### LLM Agent Configuration

Configure the Head and Planner agents via OpenClaw's agent config:

```json
{
  "agents": {
    "agentConfigs": {
      "pimclaw-head": {
        "model": "minimax-m2_1",
        "thinking": "disabled",
        "subagents": { "maxDepth": 0 },
        "cron": "*/5 * * * *",
        "sessionKey": "pimclaw-head-session"
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

### Dedicated Agent Workspaces

For production, assign dedicated workspaces:

```json
{
  "agents": {
    "list": [
      {
        "id": "pimclaw-head",
        "workspace": "/home/node/.openclaw/workspaces/pimclaw-head"
      },
      {
        "id": "pimclaw-planner",
        "workspace": "/home/node/.openclaw/workspaces/pimclaw-planner"
      }
    ]
  }
}
```

## Available Tools

Once the plugin is active, any OpenClaw agent can call these tools:

### Monitoring Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pimclaw_health` | — | System-wide health report |
| `pimclaw_list_components` | `componentType?` | List active PimClaw components |
| `pimclaw_component_status` | `componentId` | Detailed status of one component |

### Task Management Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pimclaw_task_counts` | — | Task counts by status (8 states) |
| `pimclaw_list_tasks` | `status?`, `limit?` | List tasks, optionally filtered |
| `pimclaw_route_task` | `llmDeploymentName`, `taskType`, `priority?`, `taskData?` | Submit a task directly |
| `pimclaw_retry_task` | `taskId` | Reset a failed task for retry |
| `pimclaw_revoke_task` | `taskId` | Cancel a pending task |

### Agent Tools (Head + Planner)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pimclaw_query_metrics` | `metrics?`, `deploymentName?`, `rangeMinutes?` | Query Prometheus for inference metrics |
| `pimclaw_submit_anomalies` | `events[]` | Submit detected anomaly events |
| `pimclaw_submit_task_feedback` | `taskId`, `statusSummary`, `summary`, `metricAssessments[]` | Submit follow-up feedback |
| `pimclaw_plan_task` | `taskId`, `taskType`, `config`, `reasoning`, `perfEvidence`, `simulationResults` | Submit deployment config plan |

### Planner Tools (Perf MCP + Simulator MCP)

| Tool | Description |
|------|-------------|
| `pimclaw_query_perfllm` | Query historical benchmark data |
| `pimclaw_get_perfllm_schema` | Get perfllm database table schema |
| `pimclaw_sim_register_hardware` | Register hardware for simulation |
| `pimclaw_sim_list_hardware` | List registered hardware accelerators |
| `pimclaw_sim_start` | Start SGLang simulation server |
| `pimclaw_sim_stop` | Stop simulation server |
| `pimclaw_sim_status` | Get simulation server status |
| `pimclaw_sim_benchmark` | Run benchmark simulation |
| `pimclaw_sim_dataset_info` | Preview dataset info before benchmarking |
| `pim_get_hf_models` | Search Hugging Face model catalog |

## Using PimClaw

### Check Health

```
Agent: → pimclaw_health()
       ← { totalAgents: 1, healthyAgents: 1, issues: [] }
       All components are healthy.
```

### Route a Task (Bypass Head/Planner)

```
You: Scale up the gpt-4-prod deployment.
Agent: → pimclaw_route_task({ llmDeploymentName: "gpt-4-prod", taskType: "scale-up" })
       ← { success: true, taskId: "a1b2c3…", message: "Task routed to scheduler for gpt-4-prod" }
```

### Monitor Tasks

```
You: Show me running tasks.
Agent: → pimclaw_list_tasks({ status: "running" })
       ← [{ taskId: "x1y2", llmDeploymentName: "gpt-4-prod", taskType: "scale-up", status: "running" }]
```

### Get Task Counts

```
You: How many tasks are queued?
Agent: → pimclaw_task_counts()
       ← { planning: 1, ready: 3, scheduling: 0, scheduled: 1, running: 2, done: 15, failed: 1, expired: 0 }
```

### Retry a Failed Task

```
Agent: → pimclaw_retry_task({ taskId: "x1y2" })
       ← { success: true, taskId: "x1y2" }
```

### Revoke a Pending Task

```
Agent: → pimclaw_revoke_task({ taskId: "x1y2" })
       ← { success: true, taskId: "x1y2" }
```

## The Automated Flow

The system runs autonomously in a continuous cycle:

```
[1] Head Agent (every 5 min)
  → Queries Prometheus via pimclaw_query_metrics
  → Analyzes metrics: TTFT, TPOT, QPS, throughput, GPU utilization, error rate
  → Detects anomalies (spikes, drops, trends)
  → Submits events via pimclaw_submit_anomalies

[2] Plugin processes events
  → AnomalyReceiver validates, deduplicates, groups by deployment
  → Creates a task in 'planning' state per event
  → Spawns Planner agent per deployment group

[3] Planner Agent (on-demand)
  → Queries Perf MCP for historical configs
  → Simulates candidates via Simulator MCP
  → Submits optimal config via pimclaw_plan_task

[4] Plugin executes
  → Task transitions planning → ready (with config attached)
  → Scheduler picks up ready task → creates Worker
  → Worker executes via Engine MCP (qianjin-xuntui)
  → Result reported (done/failed)

[5] Head review (later cycle)
  → Reviews completed tasks within feedback validity window
  → Submits outcome via pimclaw_submit_task_feedback
```

If the Planner times out (10 min default), a fallback config is applied automatically (scale-up by 1 replica).

## Task Lifecycle

```
planning → ready → scheduling → scheduled → running → done/failed

- planning:   Awaiting Planner to submit a configuration
- ready:      Queued and waiting for the Scheduler to pick it up
- scheduling: Scheduler is creating a Worker
- scheduled:  Worker has been assigned
- running:    Worker is executing via Engine MCP
- done:       Task completed successfully
- failed:     Task failed (can be retried up to 3 times)
- expired:    Task timed out or was manually revoked
```

## Head Feedback Configuration

Control when the Head Agent may review completed tasks:

```json
{
  "plugins": [
    {
      "id": "pimclaw",
      "enabled": true,
      "config": {
        "headFeedback": {
          "settlingDelayMs": 900000,
          "feedbackValidityMs": 3600000
        }
      }
    }
  ]
}
```

- `settlingDelayMs`: Minimum delay after `completedAt` before review is eligible (15 min default)
- `feedbackValidityMs`: Maximum age after `completedAt` for review (1 hour default)

## MCP Services

PimClaw interacts with four external MCP services:

| Service | Protocol | Purpose | Provided By |
|---------|----------|---------|-------------|
| **Prometheus** | HTTP | Real-time inference metrics | Your monitoring stack |
| **Engine MCP** | SSE | Deployment execution (qianjin-xuntui) | Platform MCP server |
| **Perf MCP** | Stdio (Python) | Historical benchmark data | `docs/perfMCP/perfllm_mcp_server.py` |
| **Simulator MCP** | SSE | Performance simulation (Hisim) | SGLang simulator service |

## Troubleshooting

### Plugin doesn't appear

```bash
openclaw plugins list            # verify pimclaw is listed
openclaw plugins inspect pimclaw # verify pimclaw is loaded
openclaw plugins doctor          # verify there are no plugin issues
```

In Docker:
```bash
docker exec openclaw-container sh -lc 'openclaw plugins list'
docker exec openclaw-container sh -lc 'openclaw plugins inspect pimclaw'
docker exec openclaw-container sh -lc 'openclaw plugins doctor'
```

### Components not starting

Check OpenClaw logs for `[PimClaw]` messages:

```
[PimClaw] Starting components…
[PimClaw] Components started (TaskRecorder → AnomalyReceiver → Scheduler)
```

If you see `[PimClaw] Scheduler error:`, the Engine MCP service may not be reachable.

### LLM Head Agent not detecting anomalies

The Head Agent runs externally. Check:
- OpenClaw cron is configured for `pimclaw-head` at `*/5 * * * *`
- The `pimclaw-head-session` session exists and is accumulating turns
- The agent can call `pimclaw_submit_anomalies` and `pimclaw_task_counts`

### Tasks stuck in "planning"

Planning tasks that exceed `planningTimeoutMs` (default 10 min) are automatically promoted to `ready` with the fallback config. If tasks still get stuck:
- Check the Planner agent logs in OpenClaw
- Verify `pimclaw-planner` agent is correctly configured
- On restart, the TaskStatusRecorder expires `planning` tasks >10 min

### Tools return "PimClaw service not running"

The `pimclaw-components` service failed to start or hasn't started yet. Verify the manifest lists the tools in `contracts.tools` and the service lifecycle completed without errors.

### Tasks stuck in "scheduling"

The Scheduler marks tasks stuck in `scheduling` for >60 s as `expired`. If tasks keep expiring, check Worker creation and Engine MCP service connectivity.

### Blocked plugin (Docker)

If `openclaw plugins inspect pimclaw` reports `blocked plugin candidate: suspicious ownership`, fix with:

```bash
docker exec -u root openclaw-container sh -lc 'chown -R node:node /tmp/pimclaw'
docker restart openclaw-container
```

## Manual Smoke Tests

After installation, verify the system is working:

1. **Health check**: `pimclaw_health` returns healthy components
2. **Submit anomaly**: `pimclaw_submit_anomalies` with a test event creates a planning task
3. **List tasks**: `pimclaw_list_tasks` shows the task in `planning` state
4. **Direct route**: `pimclaw_route_task` creates a task directly in `ready` state
5. **Revoke task**: `pimclaw_revoke_task` expires a pending task
6. **Task persistence**: Tasks survive OpenClaw restart (stale tasks may expire)
7. **Event validation**: Invalid anomaly events (missing fields) are rejected
8. **Planner fallback**: Planning task auto-promotes to `ready` with fallback config after timeout

## Compatibility

| Field | Value |
|-------|-------|
| Plugin API | `>= 2026.1.0` |
| Node.js | `>= 22.16.0` |
| Module system | ESM (`"type": "module"`) |
