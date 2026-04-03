# PimClaw Manual Test Cases

**Prerequisites:**
- OpenClaw 2026.4.1 running (Docker or local)
- PimClaw plugin installed and enabled (`openclaw plugin list` shows `pimclaw`)
- LLM agents `pimclaw-head` and `pimclaw-planner` configured in OpenClaw agent runtime (see `AGENTS.md`)
- An OpenClaw agent session open for tool calls

> All tool responses are JSON strings. The examples below show the parsed JSON.

---

## Test 1 — Health check on fresh start

**Goal:** Verify PimClaw components boot correctly when OpenClaw activates the plugin.

**Steps:**
1. Restart OpenClaw (or reload plugins)
2. In an agent session, call `pimclaw_health`

**Expected:**
```json
{
  "totalAgents": 1,
  "healthyAgents": 1,
  "issues": [],
  "agents": [
    { "agentId": "scheduler-1", "agentType": "scheduler", "status": "Listening" }
  ]
}
```

**Pass criteria:**
- `totalAgents` is 1 (scheduler only — the LLM Head and Planner agents run externally and are not tracked in the component registry)
- Scheduler shows `"status": "Listening"`
- `issues` is empty

> **Note:** The LLM Head and Planner agents are managed by OpenClaw's agent runtime. Check their status via OpenClaw's agent/session management, not `pimclaw_health`.

---

## Test 2 — Submit anomalies (LLM Head → Plugin)

**Goal:** Verify the `pimclaw_submit_anomalies` integration gate creates tasks in `planning` state and triggers the Planner.

**Steps:**
1. Call `pimclaw_submit_anomalies` with:
   ```json
   {
     "events": [
       {
         "type": "spike",
         "metricName": "ttft",
         "currentValue": 500,
         "previousValue": 150,
         "severity": "high",
         "deploymentName": "llama-70b-prod",
         "reasoning": "TTFT spike 233% with QPS increase 80%"
       }
     ]
   }
   ```
2. Note the returned `taskId` from the `tasks` array
3. Call `pimclaw_list_tasks` with `{ "status": "planning" }`

**Expected step 1:**
```json
{
  "success": true,
  "accepted": 1,
  "tasks": [{ "taskId": "<uuid>", "eventId": "<uuid>" }]
}
```

**Pass criteria:**
- Step 1 returns `success: true` with `accepted: 1`
- Step 3 shows the task in `planning` status with matching `taskId`
- The task's `llmDeploymentName` is `"llama-70b-prod"`

---

## Test 3 — Plan a task (LLM Planner → Plugin)

**Goal:** Verify the `pimclaw_plan_task` integration gate transitions a task from `planning` to `ready`.

**Steps:**
1. Create a planning task via Test 2 (or use its `taskId`)
2. Call `pimclaw_plan_task` with:
   ```json
   {
     "taskId": "<taskId from step 1>",
     "taskType": "scale-up",
     "config": { "replicas": 3, "dtype": "fp16" },
     "reasoning": "Historical and simulated data support scale-up to 3 replicas",
     "perfEvidence": "2 replicas handled 180 QPS at 140ms TTFT last week",
     "simulationResults": "3 replicas at 290 QPS: predicted TTFT 190ms"
   }
   ```
3. Call `pimclaw_list_tasks` with `{ "status": "ready" }`

**Expected step 2:**
```json
{
  "success": true,
  "taskId": "<taskId>",
  "message": "Task <taskId> planned and ready for scheduling"
}
```

**Pass criteria:**
- Step 2 returns `success: true`
- Step 3 shows the task in `ready` status with `taskType: "scale-up"` and `config` attached
- Calling `pimclaw_plan_task` on a task NOT in `planning` state returns an error

---

## Test 4 — Submit a direct task (bypass Head/Planner)

**Goal:** Verify a task can be created directly via `pimclaw_route_task`, bypassing the anomaly detection flow.

**Steps:**
1. Call `pimclaw_route_task` with:
   ```json
   { "llmDeploymentName": "gpt-4-prod", "taskType": "scale-up", "priority": "high" }
   ```
2. Note the returned `taskId`
3. Call `pimclaw_task_counts`

**Expected step 1:**
```json
{
  "success": true,
  "taskId": "<uuid>",
  "message": "Task routed to scheduler for gpt-4-prod"
}
```

**Pass criteria:**
- Step 1 returns `success: true` with a valid UUID
- The task is created directly in `ready` status (skips `planning`)
- Step 3 shows the task counted in one of the active statuses

---

## Test 5 — List and filter tasks

**Goal:** Verify task listing and status filtering work, including the new `planning` status.

**Steps:**
1. Submit an anomaly (creates a `planning` task) and a direct task (creates a `ready` task)
2. Call `pimclaw_list_tasks` with no parameters
3. Call `pimclaw_list_tasks` with `{ "status": "planning" }`
4. Call `pimclaw_list_tasks` with `{ "status": "ready" }`
5. Call `pimclaw_list_tasks` with `{ "limit": 1 }`

**Pass criteria:**
- Step 2 returns an array containing both tasks
- Each task object has: `taskId`, `status`, `llmDeploymentName`, `taskType`, `createdAt`, `priority`
- Step 3 returns only tasks with `"status": "planning"`
- Step 4 returns only tasks with `"status": "ready"`
- Step 5 returns at most 1 task

---

## Test 6 — Revoke a pending task

**Goal:** Verify a task can be cancelled before execution.

**Steps:**
1. Submit a task:
   ```json
   { "llmDeploymentName": "test-deploy", "taskType": "restart" }
   ```
2. Immediately call `pimclaw_revoke_task` with the returned `taskId`
3. Call `pimclaw_list_tasks` with `{ "status": "expired" }`

**Expected step 2:**
```json
{ "success": true, "taskId": "<taskId>" }
```

**Pass criteria:**
- Revoke returns `success: true`
- The revoked task appears in the expired list with matching `taskId`
- `pimclaw_task_counts` shows the `expired` counter incremented

> **Note:** If the scheduler picks up the task before you revoke it (within 5 seconds), the task may already be in `scheduling` or `scheduled` status. Revoke still works — it expires the task regardless of its current status.

---

## Test 7 — Retry a failed task

**Goal:** Verify a failed task can be reset for retry.

**Steps:**
1. Submit a task and wait for it to be scheduled (check with `pimclaw_list_tasks`)
2. The task will eventually fail (Worker MCP `engine` service is not available)
3. Call `pimclaw_list_tasks` with `{ "status": "failed" }` — find the task
4. Call `pimclaw_retry_task` with the `taskId`
5. Call `pimclaw_list_tasks` with `{ "status": "ready" }`

**Expected step 4:**
```json
{ "success": true, "taskId": "<taskId>" }
```

**Pass criteria:**
- After retry, the task moves back to `"status": "ready"`
- The task's `retryCount` is incremented by 1
- Calling retry on a task that has reached `maxRetries` (3) returns an error:
  ```json
  { "error": "Task <taskId> has exceeded max retries (3)" }
  ```

---

## Test 8 — List components with type filter

**Goal:** Verify component listing and filtering.

**Steps:**
1. Call `pimclaw_list_components` with no parameters
2. Call `pimclaw_list_components` with `{ "componentType": "scheduler" }`
3. Call `pimclaw_list_components` with `{ "componentType": "worker" }`

**Pass criteria:**
- Step 1 returns at least 1 component (scheduler-1)
- Step 2 returns only scheduler component(s)
- Step 3 returns worker components if any tasks are running, otherwise empty array
- Each component has: `agentId`, `agentType`, `status`, `startedAt`, `currentAction`

> **Note:** The LLM Head and Planner Agents are NOT listed here — they run externally via OpenClaw's agent runtime.

---

## Test 9 — Get single component status

**Goal:** Verify detailed component status retrieval.

**Steps:**
1. Call `pimclaw_component_status` with `{ "componentId": "scheduler-1" }`
2. Call `pimclaw_component_status` with `{ "componentId": "nonexistent-999" }`

**Expected step 1:**
```json
{
  "agentId": "scheduler-1",
  "agentType": "scheduler",
  "status": "Listening",
  "startedAt": "<Date>",
  "uptime": 120000,
  "currentAction": "Polling for tasks",
  "counters": {},
  "errors": { "errorCount": 0 }
}
```

**Expected step 2:**
```json
{ "error": "Component not found" }
```

**Pass criteria:**
- Step 1 returns the full component status
- `uptime` is a positive number in milliseconds
- Step 2 returns the "Component not found" error

---

## Test 10 — Task counts reflect lifecycle (including planning)

**Goal:** Verify task counts update as tasks move through the lifecycle, including the new `planning` state.

**Steps:**
1. Call `pimclaw_task_counts` — note the baseline counts
2. Submit an anomaly event via `pimclaw_submit_anomalies` (creates `planning` task)
3. Submit 2 direct tasks via `pimclaw_route_task` (creates `ready` tasks)
4. Immediately call `pimclaw_task_counts`
5. Wait 10 seconds (let the scheduler pick up `ready` tasks)
6. Call `pimclaw_task_counts` again

**Pass criteria:**
- Step 4: `planning` count increased by 1, `ready` count increased by up to 2
- Step 6: some tasks moved to `scheduling`, `scheduled`, or beyond
- All status counts are non-negative integers
- The response always contains all 8 status keys: `planning`, `ready`, `scheduling`, `scheduled`, `running`, `done`, `failed`, `expired`

---

## Test 11 — Service not running error

**Goal:** Verify tools return clear errors when the plugin service is not active.

**Steps:**
1. Disable the PimClaw plugin: `openclaw plugin disable pimclaw`
2. Reload OpenClaw
3. Call `pimclaw_health` from an agent session

**Expected:**
```json
{ "error": "PimClaw service not running" }
```

**Pass criteria:**
- All 10 tools return `{ "error": "PimClaw service not running" }` when the service is stopped
- Re-enabling the plugin (`openclaw plugin enable pimclaw`) and reloading restores normal operation

**Cleanup:** Re-enable the plugin after this test.

---

## Test 12 — Task persistence across restart

**Goal:** Verify task state survives OpenClaw restarts.

**Steps:**
1. Submit 2 tasks via `pimclaw_route_task`
2. Call `pimclaw_task_counts` — note the counts
3. Restart OpenClaw (or reload plugins)
4. Call `pimclaw_task_counts` again
5. Call `pimclaw_list_tasks` — verify the previously submitted tasks are present

**Pass criteria:**
- Task counts are preserved (or adjusted — stale `ready` tasks older than 60s become `expired`, stale `scheduling` tasks older than 30s become `expired`, stale `planning` tasks older than 10min become `expired`)
- Previously submitted tasks still appear in `pimclaw_list_tasks` with their original `taskId`
- Data is stored in `<stateDir>/pimclaw-tasks/tasks.json`

---

## Test 13 — Anomaly event validation and deduplication

**Goal:** Verify the AnomalyReceiver rejects invalid events and deduplicates within the configured window.

**Steps:**
1. Call `pimclaw_submit_anomalies` with an invalid event (missing required `deploymentName`):
   ```json
   { "events": [{ "type": "spike", "metricName": "ttft", "currentValue": 500, "severity": "high" }] }
   ```
2. Call `pimclaw_submit_anomalies` with a valid event
3. Immediately call `pimclaw_submit_anomalies` again with the same metric + deployment combination

**Pass criteria:**
- Step 1: event is silently skipped (accepted: 0) or returns validation error
- Step 2: event is accepted (accepted: 1)
- Step 3: duplicate event is deduplicated (accepted: 0) within the deduplication window (default 10 min)

---

## Test 14 — Planner fallback on timeout

**Goal:** Verify that planning tasks automatically receive a fallback config when the Planner times out.

**Steps:**
1. Configure a short `planningTimeoutMs` (e.g., 5000 ms) in plugin config for testing
2. Submit an anomaly event via `pimclaw_submit_anomalies`
3. Do NOT call `pimclaw_plan_task` (simulate Planner timeout)
4. Wait for the planning timeout to elapse
5. Call `pimclaw_list_tasks` with `{ "status": "ready" }`

**Pass criteria:**
- The task transitions from `planning` to `ready` automatically after the timeout
- The task has `fallbackTaskType` as its `taskType` (default: `scale-up`)
- The task's `reasoning` contains "Fallback plan applied"

---

## Quick reference

| # | Test | Tools used | Time |
|---|------|-----------|------|
| 1 | Health check on fresh start | `pimclaw_health` | 1 min |
| 2 | Submit anomalies (Head → Plugin) | `pimclaw_submit_anomalies`, `pimclaw_list_tasks` | 1 min |
| 3 | Plan a task (Planner → Plugin) | `pimclaw_plan_task`, `pimclaw_list_tasks` | 1 min |
| 4 | Submit direct task (bypass Head/Planner) | `pimclaw_route_task`, `pimclaw_task_counts` | 1 min |
| 5 | List and filter tasks | `pimclaw_submit_anomalies`, `pimclaw_route_task`, `pimclaw_list_tasks` | 2 min |
| 6 | Revoke a pending task | `pimclaw_route_task`, `pimclaw_revoke_task`, `pimclaw_list_tasks` | 1 min |
| 7 | Retry a failed task | `pimclaw_route_task`, `pimclaw_retry_task`, `pimclaw_list_tasks` | 3 min |
| 8 | List components with filter | `pimclaw_list_components` | 1 min |
| 9 | Get single component status | `pimclaw_component_status` | 1 min |
| 10 | Task counts with planning state | `pimclaw_submit_anomalies`, `pimclaw_route_task`, `pimclaw_task_counts` | 1 min |
| 11 | Service not running error | `pimclaw_health` (all tools) | 2 min |
| 12 | Task persistence across restart | `pimclaw_route_task`, `pimclaw_task_counts`, `pimclaw_list_tasks` | 3 min |
| 13 | Anomaly validation & dedup | `pimclaw_submit_anomalies` | 1 min |
| 14 | Planner fallback on timeout | `pimclaw_submit_anomalies`, `pimclaw_list_tasks` | 2 min |
