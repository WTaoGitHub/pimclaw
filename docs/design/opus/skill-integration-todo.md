# Skill Integration TODO

Integration plan for the top 4 OpenClaw skills into PimClaw v2.

---

## 1. Agent Lifecycle Management ✅

Priority: **P1** — fixes active timer leak + adds abort/cleanup safety.

### Files changed

- `src/master/base-agent.ts`
- `src/master/worker-agent.ts`
- `src/master/scheduler-agent.ts`

### Tasks

- [x] Add `LifecyclePhase` type (`init → running → aborting → cleanup → stopped → error`) to `BaseAgent`
- [x] Add `AbortController` field + `abort(reason?)` method to `BaseAgent`
- [x] Add `ownedResources` tracking with `trackResource(name, cleanup)` in `BaseAgent`
- [x] Rewrite `BaseAgent.shutdown()` as a cleanup checklist: iterate `ownedResources` in reverse, catch per-resource errors, deregister from registry last
- [x] Register MCP clients as owned resources in `connectToMCPServices()` via `trackResource()`
- [x] Fix `WorkerAgent.createTimeout()` timer leak: replaced with `createAbortableTimeout()` that cleans up via `trackResource` and respects abort signal
- [x] Pass `this.abortController.signal` to `WorkerAgent.run()` so Workers can be externally aborted
- [ ] Persist `SchedulerAgent.workers` map to `stateDir` for resume on restart
- [ ] On Scheduler restart, recover tasks stuck in `scheduling`/`scheduled` by cross-checking persisted set against `TaskStatusRecorder`
- [x] Propagate `abort()` to all child Workers when Scheduler shuts down
- [x] Add tests: abort mid-execution, cleanup resource tracking, lifecycle phase transitions (8 tests in `lifecycle.test.ts`)
- [x] Scheduler sleep is abort-aware (resolves immediately on abort signal)
- [x] Scheduler run loop checks `!this.aborted` to exit cleanly
- [x] `shutdown()` is idempotent (double-call safe)
- [x] Scheduler now creates real `WorkerAgent` instances instead of tracking task IDs in a Set

---

## 2. MCP Integration Plane

Priority: **P2** — Workers connect to Engine MCP in production; classified errors and reconnection prevent silent failures.

### Files to change

- `src/master/base-agent.ts`
- `src/master/component-registry.ts`
- `src/master/worker-agent.ts`
- `src/types/agents.ts`

### Tasks

- [ ] Add `MCPConnectionState` type (`connected | needs-auth | session-expired | transport-closed | timeout | error`) to replace the current string-based status
- [ ] Update `ComponentRegistry.updateMCPConnection()` to accept the new state type + optional error reason
- [ ] Add `classifyMCPError(error): MCPConnectionState` private method to `BaseAgent`
  - `401` / `Unauthorized` → `needs-auth`
  - `404` / `session` → `session-expired`
  - `EPIPE` / `ECONNRESET` / `closed` → `transport-closed`
  - `timeout` / `abort` → `timeout`
  - everything else → `error`
- [ ] Add per-request `AbortController` + configurable `timeoutMs` param to `callMCPTool()`
- [ ] Add `reconnectMCPService(serviceName)` method to `BaseAgent` — close stale client, re-create transport, re-connect
- [ ] On `transport-closed`, attempt one reconnection then retry the tool call once
- [ ] Add output size guard: if `JSON.stringify(result).length > 100_000`, return truncated preview
- [ ] Update `WorkerAgent` to use per-request timeout on Engine MCP calls rather than wrapping entire `run()` in `Promise.race`
- [ ] Add tests: classified error mapping, reconnection flow, oversized output truncation

---

## 3. Hook Governance Layer ✅

Priority: **P3** — hooks already exist but are fragile; making them non-fatal is a small change with high safety payoff.

### Files changed

- `src/master/anomaly-receiver.ts`
- `src/openclaw-plugin.ts`

### Tasks

#### AnomalyReceiver hooks (make non-fatal)

- [x] Wrap `hooks.onPlanningTaskCreated()` in try/catch — log errors, don't break the batch
- [x] Wrap `hooks.onPlannerTriggerFailed()` in try/catch — log errors, don't break the flow
- [x] Add `hookDurationMs` field to `ValidatedEvent` for observability
- [x] Add `HookResult` return type with optional `preventContinuation: boolean`
- [x] If `preventContinuation` is true, skip the PlannerTrigger for that event
- [x] `hookDurationMs` is recorded even when hook throws (set after try/catch)

#### Tool execution hooks (new)

- [x] Define `ToolHook` interface: `preToolUse(toolName, params)`, `postToolUse(toolName, result, durationMs)`, `postToolUseFailure(toolName, error, durationMs)`
- [x] `preToolUse` returns optional `{ updatedInput?, blockingError? }`
- [x] Add `withHooks(toolDef, hooks[])` wrapper function in `openclaw-plugin.ts`
- [x] Apply `withHooks()` to all 10 tools via `wrappedFactory` in plugin `register()`
- [x] All hook errors are non-fatal (caught, no logging to avoid noise) — hooks never kill tool execution
- [x] `registerToolHook(hook)` public function exported for external hook registration
- [x] Tool hooks cleaned up on service `stop()`
- [x] Add tests: hook error doesn't break batch, `preventContinuation`, hook duration tracking (6 tests in `hooks.test.ts`)

---

## 4. Multi-Agent Orchestration

Priority: **P4** — Scheduler→Worker parent-child tracking and abort propagation; important but currently partially stubbed.

### Files to change

- `src/types/agents.ts`
- `src/master/component-registry.ts`
- `src/master/scheduler-agent.ts`
- `src/master/worker-agent.ts`

### Tasks

#### Agent contracts

- [ ] Add `AgentContract` interface to `src/types/agents.ts`:
  ```
  { role: AgentType, allowedMCPServices: string[], maxTurns?: number,
    async: boolean, permissionScope: string }
  ```
- [ ] Define contracts for `scheduler`, `worker`, and `planner-trigger` roles

#### Parent-child tracking

- [ ] Add optional `parentId` field to `AgentRuntimeStatus` in `src/types/agents.ts`
- [ ] Add `getChildren(agentId): AgentRuntimeStatus[]` method to `ComponentRegistry`
- [ ] Set `parentId` when Workers register (parent = scheduler's agentId)

#### Scoped MCP access

- [ ] `WorkerAgent` constructor accepts `AgentContract` — only connects to MCP services listed in `allowedMCPServices`
- [ ] Validate that requested MCP services are within the contract in `connectToMCPServices()`

#### Abort propagation & delegation

- [x] Replace `SchedulerAgent.activeWorkers: Set<string>` with `workers: Map<string, WorkerAgent>` *(done in Lifecycle P1)*
- [x] On `SchedulerAgent.shutdown()`, iterate `workers` and call `worker.abort('parent scheduler shutting down')` *(done in Lifecycle P1)*
- [ ] Add delegation guard: skip dispatching a task if a Worker is already running against the same `llmDeploymentName`
- [ ] Add tests: parent-child registry, abort propagation, duplicate deployment guard

---

## Dependencies between skills

```
Lifecycle (1) ← MCP Plane (2)    # MCP reconnect relies on abort controller + resource tracking
Lifecycle (1) ← Orchestration (4) # abort propagation relies on abort() method
Hook Layer (3) is independent      # can be done in any order
```

Suggested implementation order: **1 → 3 → 2 → 4**
(Do lifecycle first for the foundation, then hooks since they're independent and small, then MCP plane and orchestration which both build on lifecycle.)
