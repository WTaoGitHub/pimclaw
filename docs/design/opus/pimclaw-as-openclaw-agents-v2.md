# Pimclaw v2 — Minimal Hybrid Architecture

> **Design Principle:** Replace only what benefits from LLM reasoning.
> Keep what's already reliable as programmatic code.

## Table of Contents

1. [Design Decision](#1-design-decision)
2. [Architecture Overview](#2-architecture-overview)
3. [What Changes](#3-what-changes)
4. [LLM Head Agent Design](#4-llm-head-agent-design)
5. [LLM Planner Agent Design](#5-llm-planner-agent-design)
6. [PimClaw Components (Unchanged)](#6-pimclaw-components-unchanged)
7. [Integration Boundary](#7-integration-boundary)
8. [Implementation Plan](#8-implementation-plan)
9. [Configuration](#9-configuration)
10. [Cost & Risk Analysis](#10-cost--risk-analysis)

---

## 1. Design Decision

### v1 Proposal (Rejected)

Convert Head, Scheduler, and Workers to LLM agents. Keep only the Recorder as a plugin.

**Why rejected:** The Scheduler and Workers are deterministic — they don't benefit from reasoning. Making them LLM agents adds cost (~$0.50–2.00/day), latency (seconds vs. milliseconds), non-determinism, and debugging complexity for zero capability gain.

### v2 Approach (Adopted)

Replace the Head Agent with **two focused LLM agents** — a **Head** for anomaly detection and a **Planner** for configuration planning. Keep Scheduler, Workers, and Recorder as programmatic TypeScript code running inside the plugin.

**Why two agents instead of one:**
- The Head runs **288 times/day**, most runs detect nothing — keep it cheap and focused on detection only
- Perf MCP, Simulator MCP, and Web Search are only needed **when there's an anomaly** — the Planner only runs then
- Detection and planning are **different reasoning tasks** — the LLM performs better when focused on one job
- The Perf and Simulator data is the project's **sellpoint** — it deserves dedicated, careful multi-step reasoning, not a side-task in the detection cycle

**What stays programmatic:**
- The Scheduler's job is deterministic FIFO + priority sorting — an LLM would make it slower and less predictable
- Workers execute a single MCP call — no reasoning needed
- The Recorder is a state machine — deterministic by definition

---

## 2. Architecture Overview

```
OPENCLAW PLATFORM
│
├─ [LLM Agent] pimclaw-head (cron: */5 * * * *)
│   ├─ Model: configurable (default: minimax-m2_1)
│   ├─ Tools: pimclaw_query_metrics, pimclaw_submit_anomalies, pimclaw_task_counts
│   ├─ Session: persistent (accumulates observation history)
│   └─ Job: Detect anomalies only
│
├─ [LLM Agent] pimclaw-planner (triggered per anomaly)
│   ├─ Model: configurable (default: minimax-m2_1)
│   ├─ Tools: Perf MCP, Simulator MCP, Web Search, pimclaw_plan_task
│   ├─ Session: ephemeral (one-shot per anomaly event)
│   └─ Job: Determine optimal deployment config
│
└─ [Plugin] pimclaw
    ├─ Service (lifecycle-managed)
    │   ├─ AnomalyReceiver   ← receives events from LLM Head
    │   ├─ PlannerTrigger    ← spawns Planner agent per event
    │   ├─ PrometheusClient   ← HTTP client for metric collection
    │   ├─ Task Status Recorder (unchanged, +planning state)
    │   ├─ Scheduler           (unchanged, loop every 5s)
    │   └─ Workers             (unchanged, ephemeral)
    │
    └─ Tools (exposed to OpenClaw agents)
        ├─ pimclaw_submit_anomalies  ← NEW: LLM Head calls this
        ├─ pimclaw_plan_task         ← NEW: LLM Planner calls this
        ├─ pimclaw_route_task
        ├─ pimclaw_list_components    ← RENAMED from pimclaw_list_agents
        ├─ pimclaw_component_status   ← RENAMED from pimclaw_agent_status
        ├─ pimclaw_health
        ├─ pimclaw_task_counts
        ├─ pimclaw_list_tasks
        ├─ pimclaw_query_metrics   ← NEW: Head queries Prometheus metrics
        ├─ pimclaw_retry_task
        └─ pimclaw_revoke_task
```

### Data Flow

```
              DETECTION (LLM)             PLANNING (LLM)           EXECUTION (code)
              ──────────────              ──────────────           ────────────────

                 [LLM Head Agent]
                 │ 1. Call pimclaw_query_metrics
                 │    (Prometheus HTTP → engine PromQL)
                 │ 2. Reason about:
                 │    - Multi-metric correlation
                 │    - Trend detection
                 │    - Seasonal patterns
                 │    - Context from history
                 │
                 ▼
        pimclaw_submit_anomalies
                 │
                 ▼
           AnomalyReceiver
           (validate, dedup, rate-limit)
                 │
                 ▼ triggers per event
                          [LLM Planner Agent]
                           │  │  │
                           │  │  └── Web Search
                           │  │      "known solutions?"
                           │  │
                           │  └───── Simulator MCP
                           │         "if config X → predicted TTFT?"
                           │
                           └──────── Perf MCP
                                     "best historical config for this load?"
                                │
                                ▼
                       pimclaw_plan_task
                       { config: {...}, reasoning: "..." }
                                │
                                ▼
                         Task Status Recorder
                         planning → ready
                                │
                                ▼
                            Scheduler
                        (poll → assign → spawn)
                                │
                                ▼
                             Workers
                        (execute via Engine MCP)
```

The LLM boundary has **two narrow gates**: the Head outputs anomaly events, the Planner outputs deployment configs. Everything else is code.

---

## 3. What Changes

### Changed: Head Agent Anomaly Detection

| Aspect | Before (v0) | After (v2) |
|--------|-------------|------------|
| **Runtime** | TypeScript `while(true)` loop | OpenClaw LLM agent, cron-triggered |
| **Metric collection** | `callMCPTool('grafana', ...)` from code | LLM calls `pimclaw_query_metrics` tool (Prometheus HTTP direct, engine-specific PromQL) |
| **Anomaly detection** | Hardcoded thresholds (`>200%` spike, `<50%` drop) | LLM reasoning with guidelines in system prompt |
| **Output** | Direct `taskRecorder.createTask()` calls | Calls `pimclaw_submit_anomalies` tool with structured events |
| **Snapshot history** | In-memory array + JSON file | OpenClaw session persistence (transcript) |
| **Scheduling** | `setInterval` every 5 minutes | Cron `*/5 * * * *` |
| **Config planning** | Hardcoded event→task mapping (spike→scale-up) | Delegated to Planner agent with Perf/Simulator/Web Search |

### New: Planner Agent for Configuration Planning

| Aspect | Before (v0) | After (v2) |
|--------|-------------|------------|
| **Config selection** | None — fixed mapping (spike→scale-up) | LLM reasons using historical perf data + simulation |
| **Data sources** | None | Perf MCP (historical), Simulator MCP (predicted), Web Search |
| **Trigger** | N/A | Spawned per anomaly event by AnomalyReceiver |
| **Output** | N/A | Calls `pimclaw_plan_task` with concrete deployment config |

### Changed: Task State Machine

**Before (v0):** 7 states
```
ready → scheduling → scheduled → running → done/failed/expired
```

**After (v2):** 8 states (new `planning` state)
```
planning → ready → scheduling → scheduled → running → done/failed/expired
```

The `planning` state represents a task awaiting configuration from the Planner agent. Once the Planner calls `pimclaw_plan_task`, the task transitions to `ready` with a concrete deployment config attached.

### Unchanged: Everything Else

| Component | Status |
|-----------|--------|
| Task Status Recorder | **Unchanged** — same code, same persistence (+ `planning` state) |
| Scheduler | **Unchanged** — same 5s polling loop, same concurrency control |
| Worker | **Unchanged** — same ephemeral execution, same MCP calls |
| Component Registry | **Unchanged** — same EventEmitter tracking |
| Plugin tools (7 of 9) | **Unchanged** — same interfaces (2 renamed: `pimclaw_list_components`, `pimclaw_component_status`) |
| Recovery logic | **Unchanged** — same stale task detection (+ `planning` >10min → expired) |

### New Components

| Component | Purpose |
|-----------|---------|
| `pimclaw_submit_anomalies` tool | Receives structured anomaly events from the LLM Head Agent |
| `pimclaw_query_metrics` tool | Queries Prometheus for inference metrics (TTFT, TPOT, QPS, throughput, GPU utilization, error rate) via engine-specific PromQL |
| `pimclaw_plan_task` tool | Receives deployment config from the LLM Planner Agent |
| `AnomalyReceiver` | Validates incoming events, triggers Planner agent per event |
| `PlannerTrigger` | Spawns Planner agent via OpenClaw API with event context |
| `PrometheusClient` | Lightweight HTTP client wrapping Prometheus `/api/v1/query` and `/api/v1/query_range` with auth support |
| LLM Head Agent definition | AGENTS.md config + system prompt (detection only) |
| LLM Planner Agent definition | AGENTS.md config + system prompt (config planning) |

---

## 4. LLM Head Agent Design

### Agent Definition

```yaml
name: PimClaw Head
agentId: pimclaw-head
model: minimax-m2_1                   # configurable — default model
thinking: disabled                    # simple pattern matching, not deep reasoning
cron: "*/5 * * * *"
```

### System Prompt

```markdown
You are PimClaw Head, a deployment monitoring agent for LLM inference services.
Your ONLY job is anomaly detection. You do NOT plan fixes — a separate Planner
agent handles that.

## Your Job

Every 5 minutes, you:
1. Call pimclaw_query_metrics to collect current metrics from Prometheus
2. Compare with your previous observations (in this conversation history)
3. Detect anomalies worth acting on
4. Submit detected anomalies via the pimclaw_submit_anomalies tool

## Metrics to Monitor

Collect via pimclaw_query_metrics (backed by Prometheus + engine-specific PromQL):
- **TTFT** (Time to First Token) — latency indicator
- **TPOT** (Time per Output Token) — generation speed
- **QPS** (Queries per Second) — request volume
- **Throughput** (tokens/sec) — capacity utilization
- **GPU Utilization** (%) — KV cache usage / token_usage as hardware saturation proxy
- **Error Rate** (%) — service health

## Anomaly Detection Guidelines

### High Severity (immediate action needed)
- TTFT increase >200% from previous observation
- Error rate >5%
- GPU utilization >95% sustained
- QPS drop >50% (possible outage)

### Medium Severity (corrective action)
- TTFT increase 100–200%
- TTFT decrease >50% (over-provisioned, wasting resources)
- Throughput drop 30–50%
- GPU utilization <30% sustained (under-utilized)

### Low Severity (monitor, no action)
- Metric fluctuations within normal operating ranges
- Single-point anomalies that self-correct

## Important Rules

- **Do NOT submit anomalies for normal fluctuations.** Only act on meaningful changes.
- **Correlate metrics.** A TTFT spike with flat QPS suggests model degradation.
  A TTFT spike with QPS spike suggests load increase. Include your correlation
  analysis in the reasoning field — the Planner agent uses it.
- **Consider history.** If you've seen the same spike for 3 consecutive observations
  and tasks are already pending, don't create duplicate tasks.
- **Check task capacity first.** Call pimclaw_task_counts. If there are >50 pending
  tasks, do NOT submit new anomalies — the system is already saturated.
- **Be specific.** Include the deployment name, actual metric values, and your
  reasoning in each anomaly event.
- **Do NOT suggest specific configs.** That's the Planner's job. Just describe
  what's wrong and how severe it is.

## Output Format

Call pimclaw_submit_anomalies with an array of events:
{
  "events": [
    {
      "type": "spike" | "drop" | "trend" | "anomaly",
      "metricName": "ttft" | "tpot" | "qps" | "throughput" | "gpu_utilization" | "error_rate",
      "currentValue": <number>,
      "previousValue": <number>,
      "severity": "high" | "medium" | "low",
      "deploymentName": "<deployment identifier>",
      "reasoning": "<your analysis of what's happening and why>"
    }
  ]
}

If no anomalies are detected, say so briefly. Do NOT call the tool with empty events.
```

### Why a Cheap Model Is Sufficient for Detection

Detection is **pattern matching with context** — not deep multi-step reasoning:
- Compare two sets of numbers (current vs. previous metrics)
- Apply threshold rules from the prompt
- Check for multi-metric correlations (e.g., TTFT + QPS)
- Decide whether to flag or ignore

A cost-efficient model handles this well. The **Planner** is where reasoning quality matters — it can be configured to a higher-tier model if needed.

Both Head and Planner models are configurable (default: `minimax-m2_1`). See [Section 9: Configuration](#9-configuration) for details.

### Session Persistence for Observation History

The LLM Head Agent runs in the same OpenClaw session across cron invocations. This means:

```
Run 1 (00:00): Collect metrics → "TTFT 150ms, all normal" → session saved
Run 2 (00:05): See Run 1 in context → Collect → "TTFT 180ms, 20% increase, monitoring"
Run 3 (00:10): See Runs 1-2 → Collect → "TTFT 250ms, trending up. 67% total increase over 10min"
Run 4 (00:15): See Runs 1-3 → Collect → "TTFT 500ms, 233% spike. Submitting high-severity event"
```

The LLM naturally accumulates context. OpenClaw's auto-compaction handles context window growth — older observations get summarized, keeping the most recent turns intact.

### Engine-Specific PromQL Maps

The `pimclaw_query_metrics` tool uses pre-built PromQL query maps tailored to each inference engine:

| Engine | TTFT | TPOT | QPS | GPU Proxy |
|--------|------|------|-----|-----------|
| **vLLM** | `vllm:time_to_first_token_seconds_bucket` | `vllm:request_time_per_output_token_seconds_bucket` | `vllm:request_success_total` | `vllm:kv_cache_usage_perc` |
| **SGLang** | `sglang:time_to_first_token_seconds_bucket` | `sglang:inter_token_latency_seconds_bucket` | `sglang:num_requests_total` | `sglang:token_usage` |

The active map is selected via the `prometheus.engine` config field (`"vllm"` or `"sglang"`). Individual queries can be overridden via `prometheus.queryOverrides` for custom setups. Label filters (e.g., `model_name`) are injected automatically via `injectLabels()` from `deploymentName` parameter and `prometheus.defaultLabels` config.

---

## 5. LLM Planner Agent Design

### Agent Definition

```yaml
name: PimClaw Planner
agentId: pimclaw-planner
model: minimax-m2_1                   # configurable — default model
thinking: enabled                      # multi-step config analysis
```

The Planner is **not cron-triggered**. It's spawned on-demand by the plugin's `PlannerTrigger` when a validated anomaly event arrives.

### System Prompt

```markdown
You are PimClaw Planner, a deployment configuration specialist for LLM inference
services. You receive anomaly events and determine the optimal deployment
configuration to resolve them.

## Your Job

You receive an anomaly event describing a performance issue with a specific
LLM deployment. Your task:

1. Understand the anomaly (type, severity, metric values, Head Agent's reasoning)
2. Query historical performance data (Perf MCP) for similar load patterns
3. Simulate candidate configurations (Simulator MCP) to predict outcomes
4. Optionally search for known solutions (Web Search)
5. Submit the optimal deployment config via the pimclaw_plan_task tool

## Available Data Sources

### Perf MCP — Historical Performance Data
Query past deployment configurations and their measured performance:
- What config ran well under similar QPS/load?
- What TTFT/TPOT did we achieve with N replicas, dtype X, quantization Y?
- What's the best-performing config for model Z on device type D?

Use this to identify **candidate configurations** based on proven results.

### Simulator MCP — Performance Simulation
Simulate how a configuration would perform under given conditions:
- "If we scale to 4 replicas with FP16, what TTFT do we expect at 200 QPS?"
- "If we switch from FP16 to INT8, how does throughput change?"
- "What's the minimum replica count to sustain 500 QPS under 200ms TTFT?"

Use this to **validate and compare candidates** before committing.

### Web Search — Known Issues & Solutions
Search for known issues, best practices, or vendor advisories:
- Model-specific performance quirks
- GPU/driver compatibility issues
- Community-reported solutions for similar symptoms

Use this **sparingly** — only when Perf and Simulator data is insufficient.

## Planning Workflow

1. **Analyze the anomaly.** Read the event type, severity, metric values, and
   the Head Agent's reasoning (correlation analysis).

2. **Query Perf MCP.** Find historical configs that performed well under similar
   conditions. Identify 2-3 candidate configurations.

3. **Simulate candidates.** Run each candidate through Simulator MCP with the
   current load parameters. Compare predicted TTFT, TPOT, throughput.

4. **Select the best config.** Choose the candidate with the best predicted
   performance that also has historical validation.

5. **Submit the plan.** Call pimclaw_plan_task with the selected configuration,
   including your reasoning and the simulation results that justify it.

## Output Format

Call pimclaw_plan_task:
{
  "taskId": "<taskId from the anomaly event>",
  "taskType": "scale-up" | "scale-down" | "restart" | "reconfigure",
  "config": {
    "replicas": <number>,
    "dtype": "fp16" | "bf16" | "fp8" | "int8" | "int4",
    "quantization": "<method or null>",
    "maxBatchSize": <number>,
    "tensorParallelism": <number>,
    // ... any deployment-specific parameters
  },
  "reasoning": "<why this config was selected>",
  "perfEvidence": "<summary of historical perf data that supports this choice>",
  "simulationResults": "<summary of simulation predictions>"
}

## Important Rules

- **Always query Perf MCP first.** Don't guess configurations — use data.
- **Always simulate before submitting.** Don't deploy unvalidated configs.
- **Prefer conservative changes.** Scale up by the minimum needed, not the maximum
  possible. Over-provisioning wastes resources.
- **Include evidence.** The reasoning, perfEvidence, and simulationResults fields
  are required — operators need to understand why this config was chosen.
- **Fail gracefully.** If Perf or Simulator MCP is unavailable, fall back to a
  safe default action (scale-up by 1 replica for spikes, no change for drops)
  and note the degraded planning in your reasoning.
```

### Why the Planner Exists Separately

**Detection and planning are different cognitive tasks:**

| Head Agent (Detection) | Planner Agent (Configuration) |
|----------------------|-------------------------------|
| "TTFT spiked 300%" | "Historical data shows 4 replicas handle this load at 150ms TTFT" |
| Simple pattern match | Multi-step data gathering + comparison |
| Runs 288×/day, mostly no-ops | Runs only when anomalies exist (2-10×/day) |
| Configurable model (default: minimax-m2_1) | Configurable model (default: minimax-m2_1) |
| Stateless per observation | Stateless per event (ephemeral session) |

**The sellpoint gets dedicated attention:** The Perf and Simulator data is the project's differentiator. A dedicated Planner can:

1. **Multi-step tool use:** Query Perf → pick candidates → simulate each → compare → select best
2. **Justify decisions:** Every planned config comes with historical evidence and simulation predictions
3. **Adapt per anomaly:** A TTFT spike needs different reasoning than GPU under-utilization
4. **Iterate:** If the first simulation shows poor results, try a different candidate

This kind of careful, multi-step reasoning would be lost if squeezed into the tail of a detection cycle.

### Example Planner Reasoning

```
Anomaly: TTFT spike 300% on deployment "llama-70b-prod" (150ms → 450ms)
Head's analysis: "QPS also increased 80% — load-driven, not degradation"

Step 1: Query Perf MCP
  → "llama-70b-prod with 2 replicas handled 180 QPS at 140ms TTFT last week"
  → "llama-70b-prod with 4 replicas handled 350 QPS at 120ms TTFT two weeks ago"
  → Current: 2 replicas at 290 QPS

Step 2: Simulate candidates
  → 3 replicas at 290 QPS: predicted TTFT 190ms ✓
  → 4 replicas at 290 QPS: predicted TTFT 130ms ✓✓
  → 3 replicas with INT8 at 290 QPS: predicted TTFT 160ms ✓

Step 3: Select
  → 3 replicas at predicted 190ms (below 200ms threshold)
  → Conservative: minimum change that resolves the anomaly
  → Historical validation: 2 replicas handled 180 QPS, so 3 should handle 290 QPS

Plan: scale-up to 3 replicas, keep FP16, keep current batch size
```

---

## 6. PimClaw Components (Unchanged)

The Scheduler, Task Status Recorder, and Workers are collectively referred to as **PimClaw Components**. They are programmatic TypeScript code running inside the plugin — not LLM agents.

### Task Status Recorder

Minor addition. Remains a plugin component managing:
- Task CRUD operations
- **8-state** machine enforcement (planning → ready → scheduling → scheduled → running → done/failed/expired)
- JSON persistence to `{stateDir}/pimclaw-tasks/tasks.json`
- Stale task recovery on startup (+ `planning` >10min → expired)

### Scheduler

No changes. Remains a programmatic polling loop:
- Polls every 5 seconds for `ready` tasks
- Enforces `maxConcurrentWorkers` (default 10)
- Transitions: ready → scheduling → scheduled
- Spawns ephemeral Workers
- Handles completion/failure callbacks from Workers
- Retry logic for failed tasks with remaining retries

### Worker

No changes. Remains ephemeral:
- Created by Scheduler with a single Task
- Connects to Engine MCP service
- Executes `execute_deployment_change` tool call
- Reports result/error to Task Status Recorder
- Cleanup in `finally` block (deterministic)
- Honors 30-minute execution timeout

### Component Registry

No changes. EventEmitter-based in-memory status tracking for all PimClaw components.

**Note:** The LLM Head and Planner Agents are NOT tracked in the Component Registry — they run outside the plugin's process, managed by OpenClaw's agent runtime. Their status is visible via OpenClaw's session/agent management instead.

---

## 7. Integration Boundary

There are **three integration points** between the LLM agents and the programmatic system.

### Metrics Input: `pimclaw_query_metrics` Tool (Prometheus → Head)

Provides the Head Agent with real-time inference metrics from Prometheus. Not a validation gate — this is the data input mechanism.

```typescript
// Tool: pimclaw_query_metrics
{
  name: 'pimclaw_query_metrics',
  description: 'Query Prometheus for inference metrics (TTFT, TPOT, QPS, throughput, GPU utilization, error rate). Called by the Head Agent for anomaly detection.',
  inputSchema: {
    type: 'object',
    properties: {
      metrics: {
        type: 'array',
        items: { type: 'string' },
        description: 'Which metrics to fetch. Options: ttft, tpot, qps, throughput, gpu_utilization, error_rate. Default: all.',
      },
      deploymentName: {
        type: 'string',
        description: 'model_name label to filter by',
      },
      rangeMinutes: {
        type: 'number',
        description: 'If set, return time-series range data for trend detection instead of an instant value',
      },
    },
  },
}
```

Backed by `PrometheusClient` (initialized in service `start()`). Uses engine-specific PromQL maps (`vllmPromQLMap` or `sglangPromQLMap`), with per-metric overrides from `prometheus.queryOverrides` config. Label matchers from `deploymentName` and `prometheus.defaultLabels` are injected via `injectLabels()` before query execution.

### Gate 1: `pimclaw_submit_anomalies` Tool (Head → Plugin)

Receives anomaly events from the Head Agent. Replaces the old `createTaskFromEvent()` calls.

```typescript
// New tool: pimclaw_submit_anomalies
{
  name: 'pimclaw_submit_anomalies',
  description: 'Submit detected anomaly events for task planning. Called by the PimClaw Head Agent after analyzing Prometheus metrics.',
  inputSchema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['spike', 'drop', 'trend', 'anomaly'] },
            metricName: { type: 'string' },
            currentValue: { type: 'number' },
            previousValue: { type: 'number' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            deploymentName: { type: 'string' },
            reasoning: { type: 'string' },
          },
          required: ['type', 'metricName', 'currentValue', 'severity', 'deploymentName'],
        },
      },
    },
    required: ['events'],
  },
}
```

### AnomalyReceiver (New)

Validates LLM output and triggers the Planner:

```typescript
class AnomalyReceiver {
  /**
   * Validate events from the LLM Head Agent.
   * - Reject events with invalid types/severities
   * - Reject events with nonsensical values (negative metrics, NaN)
   * - Deduplicate against recent events (same metric + deployment within 10min)
   * - Rate-limit: max 20 events per invocation
   * - Log all received events for audit
   *
   * For each validated event:
   * - Create a preliminary task in 'planning' state
   * - Trigger PlannerTrigger to spawn the Planner agent
   */
  receive(events: AnomalyEvent[]): ValidatedEvent[]
}
```

### PlannerTrigger (New)

Spawns the Planner agent per validated event:

```typescript
class PlannerTrigger {
  /**
   * Spawn a Planner agent via OpenClaw API for each event.
   * - Creates ephemeral session (one-shot, cleanup: delete)
   * - Passes event + taskId as attachments
   * - Sets timeout (10 minutes per planning session)
   */
  async trigger(event: ValidatedEvent, taskId: string): Promise<void> {
    await openclawApi.triggerAgent('pimclaw-planner', {
      task: `Plan optimal config for anomaly: ${event.reasoning}`,
      mode: 'run',
      cleanup: 'delete',
      runTimeoutSeconds: 600,
      attachments: [{
        type: 'json',
        content: JSON.stringify({ event, taskId })
      }]
    });
  }
}
```

### Gate 2: `pimclaw_plan_task` Tool (Planner → Plugin)

Receives deployment configuration from the Planner agent. Transitions the task from `planning` → `ready`.

```typescript
// New tool: pimclaw_plan_task
{
  name: 'pimclaw_plan_task',
  description: 'Submit a deployment configuration plan for a task in planning state. Called by the PimClaw Planner Agent after analyzing perf data and simulation results.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID to attach the plan to' },
      taskType: { type: 'string', enum: ['scale-up', 'scale-down', 'restart', 'reconfigure'] },
      config: {
        type: 'object',
        description: 'Deployment configuration to apply',
        properties: {
          replicas: { type: 'number' },
          dtype: { type: 'string' },
          quantization: { type: 'string' },
          maxBatchSize: { type: 'number' },
          tensorParallelism: { type: 'number' },
        },
      },
      reasoning: { type: 'string', description: 'Why this config was selected' },
      perfEvidence: { type: 'string', description: 'Historical perf data supporting this choice' },
      simulationResults: { type: 'string', description: 'Simulation predictions for this config' },
    },
    required: ['taskId', 'taskType', 'config', 'reasoning'],
  },
}
```

### Why Two Gates Matter

Each LLM agent's output is **structured data**, not **actions**. The plugin validates everything before it reaches the task system:

1. **Head hallucinations are contained.** Bad events are filtered by AnomalyReceiver. The LLM can't create invalid tasks.
2. **Planner hallucinations are contained.** `pimclaw_plan_task` validates that the taskId exists in `planning` state and the config schema is valid. Invalid plans are rejected.
3. **Rate limiting is enforced.** The Head can't flood the system with events. The Planner can only act on existing planning-state tasks.
4. **Audit trail.** Every event from the Head and every plan from the Planner is logged before processing.
5. **Separation of concerns.** Detection quality ≠ planning quality. Each can be tuned independently.

---

## 8. Implementation Plan

### Phase 0: Prometheus Metrics Tool ✅

**New code (completed):**
- `src/master/prometheus-client.ts` — `PrometheusClient` class wrapping `/api/v1/query` and `/api/v1/query_range`, with `AbortSignal.timeout()`, basic auth, and bearer token support
- `vllmPromQLMap` and `sglangPromQLMap` — engine-specific PromQL query maps for all 6 PimClaw metrics (P95 quantiles for TTFT/TPOT, 5-minute rate windows)
- `getPromQLMap(engine)` — engine selector function
- `injectLabels(promql, labels)` — label injection for PromQL expressions (handles existing `{...}` selectors)
- `pimclaw_query_metrics` tool registered in `openclaw-plugin.ts` — params: `metrics[]`, `deploymentName?`, `rangeMinutes?`
- `prometheus` config section in `openclaw.plugin.json` — `baseUrl`, `engine`, `queryOverrides`, `defaultLabels`, `timeoutMs`, auth fields
- Updated Head agent system prompt in `AGENTS.md` — "Collect from Grafana" → "Call `pimclaw_query_metrics`"

**Tests (completed):**
- 18 unit tests (`prometheus-client.test.ts`) — mock fetch, PromQL map coverage, error handling, auth headers, label injection
- 10 live integration tests (`prometheus-client.live.test.ts`) — verified against real Prometheus (SGLang engine, MiniMax-M2.1 model)

**Validated:**
- End-to-end: Head agent calls `pimclaw_query_metrics` inside Docker container, receives real SGLang metrics from Prometheus, performs anomaly analysis
- Network path: Docker container → `host.docker.internal` proxy → Prometheus at `10.1.112.237:29000`

### Phase 1: Extend the Task State Machine

**Changed code:**
- Add `planning` state to `TaskStatus` type
- Update `TaskStatusRecorder` to support `planning` → `ready` transition
- Add `planning` >10min → `expired` recovery rule to startup recovery
- Add `config`, `reasoning`, `perfEvidence`, `simulationResults` fields to `Task` type
- Rename `AgentRegistry` → `ComponentRegistry` in code

**Tests:**
- Task created in `planning` state
- Valid transition: `planning` → `ready` (when plan attached)
- Invalid transition: `planning` → `scheduling` (rejected — must go through `ready`)
- Stale recovery: `planning` >10min → `expired`

### Phase 2: Build the Integration Boundary

**New code:**
- `AnomalyReceiver` class — validation, dedup, rate limiting, Planner triggering
- `PlannerTrigger` class — spawns Planner agent via OpenClaw API
- `pimclaw_submit_anomalies` tool — registered in plugin
- `pimclaw_plan_task` tool — registered in plugin

**Wire:**
- `pimclaw_submit_anomalies` → `AnomalyReceiver` → creates task in `planning` state → `PlannerTrigger`
- `pimclaw_plan_task` → validates taskId + config → attaches config to task → transitions to `ready`

**Tests:**
- AnomalyReceiver: invalid events rejected, dedup works, rate limit enforced
- PlannerTrigger: spawns agent with correct parameters
- pimclaw_plan_task: validates taskId exists in `planning` state, rejects invalid configs
- Integration: submit_anomalies → planning task → plan_task → ready task

### Phase 3: Create LLM Head Agent

**New files:**
- Agent definition (AGENTS.md entry or dedicated agent config)
- System prompt (as documented in Section 4)
- Cron job configuration

**Validation:**
- Run Head Agent manually → verify it calls `pimclaw_query_metrics`
- Verify it calls `pimclaw_submit_anomalies` with correct event structure
- Verify AnomalyReceiver creates tasks in `planning` state
- Verify PlannerTrigger fires

### Phase 4: Create LLM Planner Agent

**New files:**
- Agent definition (AGENTS.md entry or dedicated agent config)
- System prompt (as documented in Section 5)

**Validation:**
- Trigger Planner manually with a test event
- Verify it calls Perf MCP → Simulator MCP → pimclaw_plan_task
- Verify task transitions from `planning` → `ready` with config attached
- Verify Scheduler picks up `ready` task and spawns Worker with config data
- End-to-end: Head detects anomaly → Planner plans config → Scheduler assigns → Worker deploys

### Phase 5: Remove Old Head Agent Code

**After** both LLM agents are validated:
- Remove `HeadAgent` class from `src/master/head-agent.ts`
- Remove Head Agent initialization from plugin service `start()`
- Remove Head Agent shutdown from plugin service `stop()`
- Remove snapshot persistence code (replaced by session persistence)
- Keep `BaseAgent` (still used by Scheduler and Worker)

### Phase 6: Cleanup

- Rename `pimclaw_list_agents` → `pimclaw_list_components` and `pimclaw_agent_status` → `pimclaw_component_status` in tool registrations
- Update `pimclaw_list_components` to list only PimClaw components (Scheduler, Task Status Recorder, Workers) — NOT the LLM agents
- Update `pimclaw_component_status` to report component-level status (not agent sessions)
- Update `pimclaw_health` to combine:
  - Component health (from Component Registry) for Scheduler, Task Status Recorder, Workers
  - LLM agent health (from OpenClaw agent API) for Head and Planner
- Update documentation

---

## 9. Configuration

### OpenClaw Agent Configs

```json
{
  "agents": {
    "agentConfigs": {
      "pimclaw-head": {
        "model": "minimax-m2_1",
        "thinking": "disabled",
        "skills": [],
        "subagents": { "maxDepth": 0 }
      },
      "pimclaw-planner": {
        "model": "minimax-m2_1",
        "thinking": "enabled",
        "skills": [],
        "subagents": { "maxDepth": 0 }
      }
    }
  }
}
```

Notes:
- Both Head and Planner default to **minimax-m2_1**. Models are configurable — swap to any supported model via the config.
- Both have `maxDepth: 0` — neither spawns subagents. The plugin's `PlannerTrigger` spawns the Planner via OpenClaw API, not via `sessions_spawn`.

### Cron Job (Head only)

```json
{
  "schedule": "*/5 * * * *",
  "agentId": "pimclaw-head",
  "sessionKey": "pimclaw-head-session"
}
```

Using a fixed `sessionKey` ensures observation history accumulates in one session.

The Planner has **no cron job** — it's triggered on-demand per anomaly event.

### Plugin Config (pimclaw additions)

```json
{
  "anomalyReceiver": {
    "maxEventsPerSubmission": 20,
    "deduplicationWindowMs": 600000,
    "planningTimeoutMs": 600000,
    "allowedMetrics": ["ttft", "tpot", "qps", "throughput", "gpu_utilization", "error_rate"]
  },
  "planner": {
    "agentId": "pimclaw-planner",
    "timeoutSeconds": 600,
    "fallbackTaskType": "scale-up",
    "fallbackConfig": { "replicaDelta": 1 }
  },
  "prometheus": {
    "baseUrl": "http://your-prometheus:9090",
    "engine": "sglang",
    "queryOverrides": {},
    "defaultLabels": { "namespace": "tenant-xyz" },
    "timeoutMs": 10000,
    "bearerToken": null,
    "username": null,
    "password": null
  }
}
```

The `fallbackConfig` is used when the Planner fails or times out — a safe default action rather than no action.

**Prometheus config fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `baseUrl` | **Yes** | Prometheus HTTP API base URL |
| `engine` | No | Inference engine: `"vllm"` (default) or `"sglang"` — selects the PromQL query map |
| `queryOverrides` | No | Per-metric PromQL overrides (e.g., `{ "ttft": "custom_query..." }`) |
| `defaultLabels` | No | Labels injected into every PromQL query (e.g., `{ "namespace": "..." }`) |
| `timeoutMs` | No | HTTP request timeout (default: 10000ms) |
| `bearerToken` | No | Bearer token for auth (takes precedence over basic auth) |
| `username` / `password` | No | Basic auth credentials |

---

## 10. Cost & Risk Analysis

### Cost

| Component | Inference Cost | Frequency | Daily Cost |
|-----------|---------------|----------|------------|
| LLM Head Agent | Model-dependent (~1K tokens/run) | 288 runs/day | Depends on model pricing |
| LLM Planner Agent | Model-dependent (~5K tokens/run, multi-step tool use) | 2–10 runs/day (anomalies only) | Depends on model pricing |
| Scheduler | $0 (code) | continuous | $0 |
| Workers | $0 (code) | on-demand | $0 |

Cost depends on the configured model. The two-agent split minimizes cost because the Planner only runs when anomalies exist.

Can be reduced further by:
- Running Head every 15min instead of 5min (3× fewer Head invocations)
- Using a cheaper model for detection if the default proves excessive

### Risk Matrix

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| Head hallucinates anomalies | Medium | Medium | AnomalyReceiver validates + deduplicates. Rate limit caps event flood. Planner is a second filter — it will see the data doesn't support the anomaly. |
| Head misses real anomalies | High | Low | Prompt includes explicit thresholds as floor. Consider keeping basic threshold checks in AnomalyReceiver as code-based fallback. |
| Planner picks wrong config | Medium | Medium | Planner must provide perfEvidence + simulationResults. Operator can review. Config validation in `pimclaw_plan_task`. Workers execute via Engine MCP which has its own safety checks. |
| Planner times out or fails | Medium | Low | `planningTimeoutMs: 600000` (10min). On timeout, task transitions to `ready` with `fallbackConfig`. System degrades to v0 behavior (simple scale-up) rather than stalling. |
| Perf/Simulator MCP unavailable | Medium | Low | Planner prompt includes fallback instructions. Plugin applies `fallbackConfig` on Planner failure. |
| Cron fails to fire | Medium | Low | OpenClaw cron is production-grade. Add `pimclaw_health` alerting if no observations in 30min. |
| Session context grows unbounded | Low | Medium | OpenClaw auto-compaction handles this. Planner uses ephemeral sessions (no growth). |
| Cost overrun | Low | Low | Head frequency is capped. Planner only fires on anomalies. Monitor token usage via OpenClaw metrics. |

### Fallback Strategy

**If the LLM Head Agent proves unreliable:**
- Re-enable the programmatic `HeadAgent` class (it's only deleted in Phase 5)
- The integration boundary (`pimclaw_submit_anomalies` → `AnomalyReceiver`) works identically with a code-based Head calling the same tool

**If the LLM Planner Agent proves unreliable:**
- Configure `fallbackConfig` to always apply (bypass Planner)
- Tasks skip `planning` state, go directly to `ready` with the fallback config
- System degrades to v0 behavior: fixed event→task mapping

**If both agents prove unreliable:**
- The integration boundary + task state machine remains valuable refactoring
- Re-enable both programmatic components behind the same tool interfaces

---

## Summary

```
v0 (current):   All programmatic. Simple. Reliable. Rigid anomaly detection.
                No config intelligence — fixed spike→scale-up mapping.

v1 (rejected):  All LLM agents. Expensive. Non-deterministic scheduling.
                Solves a problem that doesn't exist for Scheduler/Workers.

v2 (adopted):   Two focused LLM agents + PimClaw Components.

                Head Agent (configurable model, cron):
                  → Smart anomaly detection with metric correlation
                  → Runs 288×/day — use a cost-efficient model

                Planner Agent (configurable model, on-demand):
                  → Config planning using Perf + Simulator + Web Search
                  → The project's sellpoint gets dedicated reasoning
                  → Only runs when anomalies exist

                PimClaw Components (Scheduler + Workers + Task Status Recorder):
                  → Programmatic. Deterministic. Reliable. $0.
```

**Two LLM agents. Two integration tools. Two validation layers. Three programmatic components. Cheap detection, smart planning, reliable execution.**
