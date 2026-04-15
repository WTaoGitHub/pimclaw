# Suspected Bugs

## 1. Retries can expire immediately after reset

- Severity: high
- Files: `src/master/scheduler-agent.ts`, `src/master/task-status-recorder.ts`
- Issue:
  `SchedulerAgent.scheduleTask()` expires `ready` tasks when `Date.now() - createdAt > 60000`.
  `TaskStatusRecorder.resetTaskForRetry()` moves a failed task back to `ready` but does not refresh `createdAt`.
  A task that has existed for more than one minute can therefore be retried and then expired immediately on the next scheduling cycle.
- Evidence:
  `src/master/scheduler-agent.ts:105-110`
  `src/master/task-status-recorder.ts:171-177`
- Impact:
  Retry behavior is unreliable for older tasks and can silently prevent recovery from transient failures.

## 2. Retry API bypasses the task state machine

- Severity: high
- Files: `src/master/task-status-recorder.ts`, `src/openclaw-plugin.ts`
- Issue:
  `TaskStatusRecorder.resetTaskForRetry()` directly sets `task.status = 'ready'` without validating the current state against `allowedTransitions`.
  The plugin tool `pimclaw_retry_task` calls this method directly.
  This allows tasks in invalid states such as `done`, `planning`, `scheduled`, or `expired` to be moved back to `ready`.
- Evidence:
  `src/master/task-status-recorder.ts:17-26`
  `src/master/task-status-recorder.ts:161-177`
  `src/openclaw-plugin.ts:544-550`
- Impact:
  Lifecycle invariants can be broken, which may lead to duplicate execution or resurrecting tasks that should remain terminal.

## 3. Agents report Listening even when MCP dependencies failed

- Severity: high
- Files: `src/master/base-agent.ts`, `src/master/worker-agent.ts`
- Issue:
  `BaseAgent.initialize()` always transitions the agent to `Listening` after `connectToMCPServices()` returns.
  `connectToMCPServices()` catches MCP connection failures, records them, and continues instead of failing initialization.
  As a result, agents can look healthy enough to schedule even when required MCP services are unavailable.
- Evidence:
  `src/master/base-agent.ts:82-93`
  `src/master/base-agent.ts:103-145`
  `src/master/worker-agent.ts:146-156`
- Verification note:
  During `npm test`, worker startup attempted to launch the placeholder path `path/to/engine-mcp-server.js`, failed to connect, and still proceeded through scheduling paths.
- Impact:
  Health reporting is misleading, and the system can enter noisy failure and retry loops instead of surfacing dependency failure early.

## 4. Anomaly deduplication may suppress distinct incidents

- Severity: medium
- Files: `src/master/anomaly-receiver.ts`
- Issue:
  Deduplication uses only `metricName` and `deploymentName` as the key.
  Distinct events with different `type`, `severity`, or reasoning for the same metric and deployment are treated as duplicates within the deduplication window.
- Evidence:
  `src/master/anomaly-receiver.ts:93-96`
- Impact:
  A lower-signal anomaly can suppress a later higher-severity incident, which risks losing corrective action for real problems.

## 5. Hook-based planner suppression can strand tasks in planning

- Severity: medium
- Files: `src/master/anomaly-receiver.ts`
- Issue:
  If `onPlanningTaskCreated()` returns `{ preventContinuation: true }`, planner triggering is skipped.
  No fallback state transition is applied in that branch, so the task remains in `planning` unless external code changes it.
- Evidence:
  `src/master/anomaly-receiver.ts:130-155`
- Impact:
  Hook users can unintentionally deadlock tasks in a non-terminal state.

## 6. Test command is configured in watch mode for CI-style execution

- Severity: low
- Files: `package.json`
- Issue:
  The `test` script is `vitest`, which starts watch mode by default instead of exiting after one run.
- Evidence:
  `package.json:25`
- Verification note:
  Running `npm test` did not terminate on its own and eventually hit the tool timeout after printing failures.
- Impact:
  Automated verification is awkward and can hang in non-interactive environments.

## 7. Existing agent registry tests are failing against current implementation

- Severity: medium
- Files: `src/master/__tests__/agent-registry.test.ts`, `src/master/component-registry.ts`
- Issue:
  The current test suite reports 7 failures in `agent-registry.test.ts`.
  Failures include mismatched MCP connection shapes, mismatched emitted event payload fields, and health-report expectations.
- Verification note:
  Observed from `npm test` on 2026-04-03.
- Impact:
  Either the implementation drifted from the intended contract or the tests are stale. In both cases, the contract around component registry behavior is currently unclear.
