# PimClaw Manual Test Cases

**Prerequisites:**
- OpenClaw 2026.4.1 running (Docker or local)
- PimClaw plugin installed and enabled (`openclaw plugin list` shows `pimclaw`)
- An OpenClaw agent session open for tool calls

> All tool responses are JSON strings. The examples below show the parsed JSON.

---

## Test 1 — Health check on fresh start

**Goal:** Verify PimClaw agents boot correctly when OpenClaw activates the plugin.

**Steps:**
1. Restart OpenClaw (or reload plugins)
2. In an agent session, call `pimclaw_health`

**Expected:**
```json
{
  "totalAgents": 2,
  "healthyAgents": 2,
  "issues": [],
  "agents": [
    { "agentId": "scheduler-1", "agentType": "scheduler", "status": "Listening" },
    { "agentId": "head-1", "agentType": "head", "status": "Listening" }
  ]
}
```

**Pass criteria:**
- `totalAgents` is 2 (scheduler + head)
- Both agents show `"status": "Listening"`
- `issues` is empty (MCP connection errors are expected in stderr but should not cause health issues on first boot)

---

## Test 2 — Submit a task

**Goal:** Verify a task can be created and appears in the task list.

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

**Expected step 3:**
- `ready` count is >= 1 (the task may already have been picked up by the scheduler)
- OR `scheduling` / `scheduled` count is >= 1 (if the scheduler already processed it)

**Pass criteria:**
- Step 1 returns `success: true` with a valid UUID
- Step 3 shows the task counted in one of the active statuses

---

## Test 3 — List and filter tasks

**Goal:** Verify task listing and status filtering work.

**Steps:**
1. Submit 2 tasks:
   ```json
   { "llmDeploymentName": "llama-70b", "taskType": "restart" }
   { "llmDeploymentName": "mistral-7b", "taskType": "scale-down" }
   ```
2. Call `pimclaw_list_tasks` with no parameters
3. Call `pimclaw_list_tasks` with `{ "status": "done" }`
4. Call `pimclaw_list_tasks` with `{ "limit": 1 }`

**Pass criteria:**
- Step 2 returns an array containing the submitted tasks (may also include prior tasks)
- Each task object has: `taskId`, `status`, `llmDeploymentName`, `taskType`, `createdAt`, `priority`
- Step 3 returns only tasks with `"status": "done"` (may be empty)
- Step 4 returns at most 1 task

---

## Test 4 — Revoke a pending task

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

## Test 5 — Retry a failed task

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

## Test 6 — List agents with type filter

**Goal:** Verify agent listing and filtering.

**Steps:**
1. Call `pimclaw_list_agents` with no parameters
2. Call `pimclaw_list_agents` with `{ "agentType": "scheduler" }`
3. Call `pimclaw_list_agents` with `{ "agentType": "head" }`
4. Call `pimclaw_list_agents` with `{ "agentType": "worker" }`

**Pass criteria:**
- Step 1 returns at least 2 agents (scheduler-1, head-1)
- Step 2 returns only scheduler agent(s)
- Step 3 returns only head agent(s)
- Step 4 returns worker agents if any tasks are running, otherwise empty array
- Each agent has: `agentId`, `agentType`, `status`, `startedAt`, `currentAction`

---

## Test 7 — Get single agent status

**Goal:** Verify detailed agent status retrieval.

**Steps:**
1. Call `pimclaw_agent_status` with `{ "agentId": "head-1" }`
2. Call `pimclaw_agent_status` with `{ "agentId": "nonexistent-999" }`

**Expected step 1:**
```json
{
  "agentId": "head-1",
  "agentType": "head",
  "status": "Listening",
  "startedAt": "<Date>",
  "uptime": 120000,
  "currentAction": "Observing metrics",
  "mcpConnections": { "grafana": "error", "perf": "error", "simulator": "error" },
  "counters": { "snapshotsCollected": 1, "eventsDetected": 0 },
  "errors": { "errorCount": 0 }
}
```

**Expected step 2:**
```json
{ "error": "Agent not found" }
```

**Pass criteria:**
- Step 1 returns the full agent status with `mcpConnections` showing all three services (likely `"error"` since MCP services are not deployed)
- `uptime` is a positive number in milliseconds
- Step 2 returns the "Agent not found" error

---

## Test 8 — Task counts reflect lifecycle

**Goal:** Verify task counts update as tasks move through the lifecycle.

**Steps:**
1. Call `pimclaw_task_counts` — note the baseline counts
2. Submit 3 tasks via `pimclaw_route_task`
3. Immediately call `pimclaw_task_counts`
4. Wait 10 seconds (let the scheduler pick them up)
5. Call `pimclaw_task_counts` again

**Pass criteria:**
- Step 3: `ready` count increased by up to 3 vs baseline
- Step 5: some tasks moved to `scheduling`, `scheduled`, or beyond
- All status counts are non-negative integers
- The response always contains all 7 status keys: `ready`, `scheduling`, `scheduled`, `running`, `done`, `failed`, `expired`

---

## Test 9 — Service not running error

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
- All 8 tools return `{ "error": "PimClaw service not running" }` when the service is stopped
- Re-enabling the plugin (`openclaw plugin enable pimclaw`) and reloading restores normal operation

**Cleanup:** Re-enable the plugin after this test.

---

## Test 10 — Task persistence across restart

**Goal:** Verify task state survives OpenClaw restarts.

**Steps:**
1. Submit 2 tasks via `pimclaw_route_task`
2. Call `pimclaw_task_counts` — note the counts
3. Restart OpenClaw (or reload plugins)
4. Call `pimclaw_task_counts` again
5. Call `pimclaw_list_tasks` — verify the previously submitted tasks are present

**Pass criteria:**
- Task counts are preserved (or adjusted — stale `ready` tasks older than 60s become `expired`, stale `scheduling` tasks older than 30s become `expired`)
- Previously submitted tasks still appear in `pimclaw_list_tasks` with their original `taskId`
- Data is stored in `<stateDir>/pimclaw-tasks/tasks.json`

---

## Quick reference

| # | Test | Tools used | Time |
|---|------|-----------|------|
| 1 | Health check on fresh start | `pimclaw_health` | 1 min |
| 2 | Submit a task | `pimclaw_route_task`, `pimclaw_task_counts` | 1 min |
| 3 | List and filter tasks | `pimclaw_route_task`, `pimclaw_list_tasks` | 2 min |
| 4 | Revoke a pending task | `pimclaw_route_task`, `pimclaw_revoke_task`, `pimclaw_list_tasks` | 1 min |
| 5 | Retry a failed task | `pimclaw_route_task`, `pimclaw_retry_task`, `pimclaw_list_tasks` | 3 min |
| 6 | List agents with filter | `pimclaw_list_agents` | 1 min |
| 7 | Get single agent status | `pimclaw_agent_status` | 1 min |
| 8 | Task counts reflect lifecycle | `pimclaw_route_task`, `pimclaw_task_counts` | 1 min |
| 9 | Service not running error | `pimclaw_health` (all tools) | 2 min |
| 10 | Task persistence across restart | `pimclaw_route_task`, `pimclaw_task_counts`, `pimclaw_list_tasks` | 3 min |
