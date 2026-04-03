# Pimclaw v2 — Minimal Hybrid Architecture

> **Design Principle:** Replace only what benefits from LLM reasoning.
> Keep what's already reliable as programmatic code.

## Table of Contents

1. [Design Decision](#1-design-decision)
2. [Architecture Overview](#2-architecture-overview)
3. [What Changes](#3-what-changes)
4. [LLM Head Agent Design](#4-llm-head-agent-design)
5. [Programmatic Components (Unchanged)](#5-programmatic-components-unchanged)
6. [Integration Boundary](#6-integration-boundary)
7. [Implementation Plan](#7-implementation-plan)
8. [Configuration](#8-configuration)
9. [Cost & Risk Analysis](#9-cost--risk-analysis)

---

## 1. Design Decision

### v1 Proposal (Rejected)

Convert Head, Scheduler, and Workers to LLM agents. Keep only the Recorder as a plugin.

**Why rejected:** The Scheduler and Workers are deterministic — they don't benefit from reasoning. Making them LLM agents adds cost (~$0.50–2.00/day), latency (seconds vs. milliseconds), non-determinism, and debugging complexity for zero capability gain.

### v2 Approach (Adopted)

Replace **only the Head Agent's anomaly detection** with an LLM agent. Keep Scheduler, Workers, and Recorder as programmatic TypeScript code running inside the plugin.

**Why this is better:**
- The Head Agent's observe-think-decide loop is the **one place** where LLM reasoning adds genuine value (pattern recognition, multi-metric correlation, contextual judgment)
- The Scheduler's job is deterministic FIFO + priority sorting — an LLM would make it slower and less predictable
- Workers execute a single MCP call — no reasoning needed
- The Recorder is a state machine — deterministic by definition

---

## 2. Architecture Overview

```
OPENCLAW PLATFORM
│
├─ [LLM Agent] pimclaw-head (cron: */5 * * * *)
│   ├─ Model: claude-sonnet
│   ├─ Tools: Grafana MCP, pimclaw_submit_anomalies
│   ├─ Session: persistent (accumulates observation history)
│   └─ Job: Observe metrics → reason about anomalies → submit events
│
└─ [Plugin] pimclaw
    ├─ Service (lifecycle-managed)
    │   ├─ AnomalyReceiver  ← receives events from LLM Head
    │   ├─ TaskPlanner       ← converts events into tasks
    │   ├─ TaskStatusRecorder (unchanged)
    │   ├─ SchedulerAgent    (unchanged, loop every 5s)
    │   └─ WorkerAgents      (unchanged, ephemeral)
    │
    └─ Tools (exposed to OpenClaw agents)
        ├─ pimclaw_submit_anomalies  ← NEW: LLM Head calls this
        ├─ pimclaw_route_task
        ├─ pimclaw_list_agents
        ├─ pimclaw_agent_status
        ├─ pimclaw_health
        ├─ pimclaw_task_counts
        ├─ pimclaw_list_tasks
        ├─ pimclaw_retry_task
        └─ pimclaw_revoke_task
```

### Data Flow

```
                    LLM BOUNDARY                    PROGRAMMATIC BOUNDARY
                    ───────────                     ─────────────────────

Grafana MCP ──→  [LLM Head Agent]  ──→  pimclaw_submit_anomalies tool
                  │                              │
                  │ Reason about:                │
                  │ - Multi-metric correlation   ▼
                  │ - Trend detection        AnomalyReceiver
                  │ - Seasonal patterns          │
                  │ - Context from history       ▼
                  │                          TaskPlanner
                  │                          (event → task mapping,
                  │                           deterministic rules)
                  │                              │
                  │                              ▼
                  │                       TaskStatusRecorder
                  │                          (task CRUD)
                  │                              │
                  │                              ▼
                  │                        SchedulerAgent
                  │                      (poll → assign → spawn)
                  │                              │
                  │                              ▼
                  │                        WorkerAgents
                  │                      (execute via Engine MCP)
```

The LLM boundary is **narrow**: the Head Agent outputs structured anomaly events. Everything downstream is code.

---

## 3. What Changes

### Changed: Head Agent Anomaly Detection

| Aspect | Before (v0) | After (v2) |
|--------|-------------|------------|
| **Runtime** | TypeScript `while(true)` loop | OpenClaw LLM agent, cron-triggered |
| **Metric collection** | `callMCPTool('grafana', ...)` from code | LLM calls Grafana MCP tools directly |
| **Anomaly detection** | Hardcoded thresholds (`>200%` spike, `<50%` drop) | LLM reasoning with guidelines in system prompt |
| **Output** | Direct `taskRecorder.createTask()` calls | Calls `pimclaw_submit_anomalies` tool with structured events |
| **Snapshot history** | In-memory array + JSON file | OpenClaw session persistence (transcript) |
| **Scheduling** | `setInterval` every 5 minutes | Cron `*/5 * * * *` |

### Unchanged: Everything Else

| Component | Status |
|-----------|--------|
| TaskStatusRecorder | **Unchanged** — same code, same persistence |
| SchedulerAgent | **Unchanged** — same 5s polling loop, same concurrency control |
| WorkerAgent | **Unchanged** — same ephemeral execution, same MCP calls |
| AgentRegistry | **Unchanged** — same EventEmitter tracking |
| Task state machine | **Unchanged** — same 7 states, same transitions |
| Plugin tools (7 of 8) | **Unchanged** — same interfaces |
| Recovery logic | **Unchanged** — same stale task detection |

### New Components

| Component | Purpose |
|-----------|---------|
| `pimclaw_submit_anomalies` tool | Receives structured anomaly events from the LLM Head Agent |
| `AnomalyReceiver` | Validates and normalizes incoming events from the LLM |
| `TaskPlanner` | Converts validated events into tasks (replaces `createTaskFromEvent`) |
| LLM Head Agent definition | AGENTS.md config + system prompt |

---

## 4. LLM Head Agent Design

### Agent Definition

```yaml
# agents/pimclaw-head.md or AGENTS.md entry
name: PimClaw Head
agentId: pimclaw-head
model: anthropic/claude-sonnet-4-6
thinking: enabled
cron: "*/5 * * * *"
```

### System Prompt

```markdown
You are PimClaw Head, a deployment monitoring agent for LLM inference services.

## Your Job

Every 5 minutes, you:
1. Collect current metrics from Grafana
2. Compare with your previous observations (in this conversation history)
3. Detect anomalies worth acting on
4. Submit detected anomalies via the pimclaw_submit_anomalies tool

## Metrics to Monitor

Collect from Grafana:
- **TTFT** (Time to First Token) — latency indicator
- **TPOT** (Time per Output Token) — generation speed
- **QPS** (Queries per Second) — request volume
- **Throughput** (tokens/sec) — capacity utilization
- **GPU Utilization** (%) — hardware saturation
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
  A TTFT spike with QPS spike suggests load increase. Different root causes need
  different task types.
- **Consider history.** If you've seen the same spike for 3 consecutive observations
  and tasks are already pending, don't create duplicate tasks.
- **Check task capacity first.** Call pimclaw_task_counts. If there are >50 pending
  tasks, do NOT submit new anomalies — the system is already saturated.
- **Be specific.** Include the deployment name, actual metric values, and your
  reasoning in each anomaly event.

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
      "suggestedAction": "scale-up" | "scale-down" | "restart" | "investigate",
      "reasoning": "<your analysis of why this is an anomaly>"
    }
  ]
}

If no anomalies are detected, say so briefly. Do NOT call the tool with empty events.
```

### Why LLM Excels Here

The current Head Agent uses two fixed rules:

```typescript
// Current: rigid, misses nuance
if (percentChange > 200) → spike
if (currTTFT < prevTTFT * 0.5) → drop
```

The LLM Head Agent can:

1. **Correlate metrics:** "TTFT spiked 180% but QPS also doubled — this is load-driven, not degradation. Suggest scale-up, not restart."

2. **Detect trends:** "TTFT has increased 20% each of the last 4 observations. It's not a spike yet, but the trend suggests imminent saturation."

3. **Avoid false positives:** "TTFT dropped from 300ms to 100ms, but that's because QPS dropped to near-zero — it's off-peak hours, not over-provisioning."

4. **Provide reasoning:** Every anomaly includes human-readable analysis of *why* it was flagged, improving operator trust and debuggability.

5. **Handle novel patterns:** Combinations of metrics that weren't anticipated in hardcoded rules.

### Session Persistence for Observation History

The LLM Head Agent runs in the same OpenClaw session across cron invocations. This means:

```
Run 1 (00:00): Collect metrics → "TTFT 150ms, all normal" → session saved
Run 2 (00:05): See Run 1 in context → Collect → "TTFT 180ms, 20% increase, monitoring"
Run 3 (00:10): See Runs 1-2 → Collect → "TTFT 250ms, trending up. 67% total increase over 10min"
Run 4 (00:15): See Runs 1-3 → Collect → "TTFT 500ms, 233% spike. Submitting high-severity event"
```

The LLM naturally accumulates context. OpenClaw's auto-compaction handles context window growth — older observations get summarized, keeping the most recent turns intact.

---

## 5. Programmatic Components (Unchanged)

### TaskStatusRecorder

No changes. Remains a plugin service managing:
- Task CRUD operations
- 7-state machine enforcement (ready → scheduling → scheduled → running → done/failed/expired)
- JSON persistence to `{stateDir}/pimclaw-tasks/tasks.json`
- Stale task recovery on startup

### SchedulerAgent

No changes. Remains a programmatic polling loop:
- Polls every 5 seconds for `ready` tasks
- Enforces `maxConcurrentWorkers` (default 10)
- Transitions: ready → scheduling → scheduled
- Spawns ephemeral WorkerAgents
- Handles completion/failure callbacks from Workers
- Retry logic for failed tasks with remaining retries

### WorkerAgent

No changes. Remains ephemeral:
- Created by Scheduler with a single Task
- Connects to Engine MCP service
- Executes `execute_deployment_change` tool call
- Reports result/error to TaskStatusRecorder
- Cleanup in `finally` block (deterministic)
- Honors 30-minute execution timeout

### AgentRegistry

No changes. EventEmitter-based in-memory status tracking for all programmatic agents.

**Note:** The LLM Head Agent is NOT tracked in the AgentRegistry — it runs outside the plugin's process, scheduled by OpenClaw's cron system. Its status is visible via OpenClaw's session/agent management instead.

---

## 6. Integration Boundary

### The `pimclaw_submit_anomalies` Tool

This is the **single integration point** between the LLM Head Agent and the programmatic system. It replaces the direct `createTaskFromEvent()` calls that the old code-based Head Agent made.

```typescript
// New tool: pimclaw_submit_anomalies
{
  name: 'pimclaw_submit_anomalies',
  description: 'Submit detected anomaly events for task planning. Called by the PimClaw Head Agent after analyzing Grafana metrics.',
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
            suggestedAction: { type: 'string', enum: ['scale-up', 'scale-down', 'restart', 'investigate'] },
            reasoning: { type: 'string' },
          },
          required: ['type', 'metricName', 'currentValue', 'severity', 'suggestedAction'],
        },
      },
    },
    required: ['events'],
  },
}
```

### AnomalyReceiver (New)

Validates and sanitizes LLM output before it reaches the task system:

```typescript
class AnomalyReceiver {
  /**
   * Validate events from the LLM Head Agent.
   * - Reject events with invalid types/severities
   * - Reject events with nonsensical values (negative metrics, NaN)
   * - Deduplicate against recent events (same metric + deployment within 10min)
   * - Rate-limit: max 20 events per invocation
   * - Log all received events for audit
   */
  receive(events: AnomalyEvent[]): ValidatedEvent[]
}
```

This is the **LLM guardrail** — it ensures that even if the LLM produces bad output, the downstream system only processes valid, deduplicated events.

### TaskPlanner (Refactored from HeadAgent)

Deterministic mapping from validated events to tasks:

```typescript
class TaskPlanner {
  /**
   * Convert validated anomaly events into tasks.
   * Extracted from the old HeadAgent.createTaskFromEvent() — same logic.
   *
   * Rules:
   * - spike → scale-up task
   * - drop  → scale-down task
   * - trend → scale-up task (preemptive)
   * - anomaly → investigate task
   * - severity maps to priority: high→high, medium→medium, low→low
   */
  planTasks(events: ValidatedEvent[]): Task[]
}
```

### Why This Boundary Matters

The LLM Head Agent's output is **structured data** (events), not **actions** (task creation). The plugin validates, deduplicates, and converts events into tasks deterministically. This means:

1. **LLM hallucination is contained.** Bad events are filtered by AnomalyReceiver. The LLM can't create invalid tasks or corrupt the task state machine.
2. **Task creation rules stay in code.** The mapping from event type to task type is deterministic and testable.
3. **Rate limiting is enforced.** The LLM can't flood the system with events.
4. **Audit trail.** Every event from the LLM is logged before processing.

---

## 7. Implementation Plan

### Phase 1: Build the Integration Boundary

**New code:**
- `AnomalyReceiver` class — validation, dedup, rate limiting
- `TaskPlanner` class — refactored from `HeadAgent.createTaskFromEvent()`
- `pimclaw_submit_anomalies` tool — registered in plugin

**Refactored code:**
- Extract event→task mapping from `HeadAgent` into `TaskPlanner`
- Wire `pimclaw_submit_anomalies` → `AnomalyReceiver` → `TaskPlanner` → `TaskStatusRecorder`

**Tests:**
- AnomalyReceiver: invalid events rejected, dedup works, rate limit enforced
- TaskPlanner: event types map to correct task types and priorities
- Integration: tool call → events → tasks in Recorder

### Phase 2: Create LLM Head Agent

**New files:**
- Agent definition (AGENTS.md entry or dedicated agent config)
- System prompt (as documented in Section 4)
- Cron job configuration

**Validation:**
- Run Head Agent manually → verify it calls Grafana MCP
- Verify it calls `pimclaw_submit_anomalies` with correct event structure
- Verify events flow through AnomalyReceiver → TaskPlanner → Recorder
- Verify Scheduler picks up resulting tasks and spawns Workers

### Phase 3: Remove Old Head Agent Code

**After** the LLM Head Agent is validated:
- Remove `HeadAgent` class from `src/master/head-agent.ts`
- Remove Head Agent initialization from plugin service `start()`
- Remove Head Agent shutdown from plugin service `stop()`
- Remove snapshot persistence code (replaced by session persistence)
- Keep `BaseAgent` (still used by Scheduler and Worker)

### Phase 4: Cleanup

- Update `pimclaw_list_agents` and `pimclaw_agent_status` tools to reflect that Head is now external
- Update `pimclaw_health` to query OpenClaw agent status for Head
- Update documentation

---

## 8. Configuration

### OpenClaw Agent Config

```json
{
  "agents": {
    "agentConfigs": {
      "pimclaw-head": {
        "model": "anthropic/claude-sonnet-4-6",
        "thinking": "enabled",
        "skills": [],
        "subagents": { "maxDepth": 0 }
      }
    }
  }
}
```

Note: `maxDepth: 0` — the Head Agent does **not** spawn subagents. It only calls tools. All spawning happens in the programmatic Scheduler.

### Cron Job

```json
{
  "schedule": "*/5 * * * *",
  "agentId": "pimclaw-head",
  "sessionKey": "pimclaw-head-session"
}
```

Using a fixed `sessionKey` ensures observation history accumulates in one session.

### Plugin Config (pimclaw-recorder additions)

```json
{
  "anomalyReceiver": {
    "maxEventsPerSubmission": 20,
    "deduplicationWindowMs": 600000,
    "allowedMetrics": ["ttft", "tpot", "qps", "throughput", "gpu_utilization", "error_rate"]
  }
}
```

---

## 9. Cost & Risk Analysis

### Cost

| Component | Inference Cost | Frequency |
|-----------|---------------|-----------|
| LLM Head Agent | ~$0.01–0.03 per run (sonnet, ~2K tokens) | 288 runs/day (every 5 min) |
| **Daily total** | **~$3–9/day** | |
| Scheduler | $0 (code) | continuous |
| Workers | $0 (code) | on-demand |

**Note:** This is higher than the v1 estimate because the Head runs on sonnet with thinking enabled, and Grafana tool calls may return substantial metric data. Can be reduced by:
- Using haiku for the Head (lower reasoning quality)
- Running every 15min instead of 5min (3× cheaper)
- Disabling thinking (faster, cheaper, less nuanced)

### Risk Matrix

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| LLM hallucinates anomalies | Medium | Medium | AnomalyReceiver validates + deduplicates. TaskPlanner is deterministic. Rate limit caps event flood. |
| LLM misses real anomalies | High | Low | Prompt includes explicit thresholds as floor. Consider keeping basic threshold checks in AnomalyReceiver as fallback. |
| Cron fails to fire | Medium | Low | OpenClaw cron is production-grade. Add `pimclaw_health` alerting if no events received in 30min. |
| Session context grows unbounded | Low | Medium | OpenClaw auto-compaction handles this. Set max context tokens. |
| Grafana MCP unavailable | Medium | Low | LLM reports tool call failure. AnomalyReceiver logs gap. Same risk as current code-based Head. |
| Cost overrun | Low | Low | Cap at sonnet. Monitor token usage via OpenClaw metrics. |

### Fallback Strategy

If the LLM Head Agent proves unreliable:
- Re-enable the programmatic `HeadAgent` class (it's only deleted in Phase 3)
- The integration boundary (`pimclaw_submit_anomalies` → `AnomalyReceiver` → `TaskPlanner`) remains useful even with a code-based Head — it's cleaner separation of concerns than the current monolithic `HeadAgent.observeThinkDecideCycle()`

---

## Summary

```
v0 (current):  All programmatic. Simple. Reliable. Rigid anomaly detection.

v1 (rejected): All LLM agents. Expensive. Non-deterministic scheduling.
               Solves a problem that doesn't exist for Scheduler/Workers.

v2 (adopted):  LLM Head + programmatic everything else.
               Smart anomaly detection where it matters.
               Deterministic execution where it matters.
               Clean boundary with validation guardrails.
```

**One LLM agent. One new tool. One validation layer. Maximum value, minimum risk.**
