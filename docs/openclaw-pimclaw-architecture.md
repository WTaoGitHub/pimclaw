# OpenClaw, Agents, Subagents, and PimClaw

## Purpose

This document captures the working mental model for three related things:

1. the OpenClaw host platform
2. the OpenClaw agent and subagent runtime model
3. the PimClaw plugin and how it fits into OpenClaw

It is intended as a compact architecture note for future development work in this repository.

## OpenClaw in One View

OpenClaw is the host platform and control plane.

It is a local-first AI gateway that runs named agents, maintains sessions, exposes tools, manages delivery across channels, and loads plugins that extend the runtime.

In practice, OpenClaw owns:

- gateway startup and runtime lifecycle
- session storage and routing
- agent profiles and per-agent configuration
- tool registration and effective tool availability
- plugin discovery, validation, loading, and enablement
- background task tracking
- channel delivery and thread routing
- runtime policy, including sandbox and plugin permissions

For PimClaw, the important point is that OpenClaw is the outer runtime boundary. PimClaw runs inside OpenClaw rather than beside it.

## OpenClaw Plugin Model

OpenClaw has a native plugin SDK. A plugin uses `definePluginEntry(...)` and can register capabilities through `OpenClawPluginApi`.

Relevant plugin extension points include:

- tools
- services
- commands
- providers
- hooks
- channels
- memory and context-engine slots

PimClaw currently uses the plugin model in the most relevant way for its purpose:

- it registers a background service
- it registers agent-callable tools

This means PimClaw should be treated as an OpenClaw-native plugin, not as a standalone daemon that happens to be launched from OpenClaw.

## OpenClaw Plugin Features

OpenClaw's plugin system is broader and more mature than PimClaw's current usage of it.

The most important plugin features to remember are below.

### Plugin entry and manifest

An OpenClaw native plugin typically has two key pieces:

- a runtime module that exports a plugin entry through `definePluginEntry(...)`
- an `openclaw.plugin.json` manifest that declares plugin metadata and contracts

The manifest is used to describe things such as:

- plugin id
- whether the plugin is enabled by default
- config schema
- tool contracts
- provider-related metadata for provider plugins
- plugin kind for special slots such as memory or context-engine

For PimClaw, the manifest currently declares:

- plugin id `pimclaw`
- disabled-by-default behavior
- tool contracts for PimClaw's tool surface

### Registration surfaces

`OpenClawPluginApi` exposes a large registration surface. Important capabilities include:

- `registerTool`
- `registerService`
- `registerCommand`
- `registerHook`
- `registerChannel`
- `registerGatewayMethod`
- `registerCli`
- `registerProvider`
- `registerSpeechProvider`
- `registerMediaUnderstandingProvider`
- `registerImageGenerationProvider`
- memory and context-engine registration hooks

This matters because PimClaw currently uses only two of the most relevant surfaces:

- services
- tools

If PimClaw evolves, it could potentially use more of the plugin system, but it should do so only when there is a real need.

### Services

OpenClaw plugins can register lifecycle-managed services.

This is the key host feature that PimClaw relies on. A service gets:

- host-managed startup
- host-managed shutdown
- plugin logging
- a `stateDir` for persistent plugin-owned runtime state

This is why PimClaw's background orchestration agents belong inside a plugin service instead of being modeled as a separate daemon.

### Tool factories and runtime context

Plugin tools are created with trusted runtime context, not only raw tool arguments.

The tool context can include data such as:

- workspace directory
- agent directory
- agent id
- session key
- session id
- channel and delivery context
- requester identity metadata
- runtime-resolved config snapshot

This means plugin tools can behave differently depending on the actual OpenClaw runtime context in which they are exposed.

For PimClaw, this matters because its tools are intended to be called from OpenClaw agent sessions and therefore live inside the OpenClaw agent/runtime model.

### Config schema support

OpenClaw plugins can declare config schemas.

The plugin config contract supports validation and also allows additional metadata for:

- docs
- config UIs
- safe parsing and validation

OpenClaw stores per-plugin config under the broader plugin config structure, including per-entry enablement and plugin-specific config payloads.

This is important for PimClaw because its current `ConfigurationManager` should eventually be reconciled with OpenClaw's plugin config system rather than living as a disconnected configuration path.

### Discovery and loading

OpenClaw has a formal plugin discovery and bootstrap path.

At gateway startup it:

- normalizes plugin config
- applies auto-enable rules
- loads configured plugins
- installs runtime environment for plugin behavior
- records diagnostics for plugin load problems

This is a host-level system. PimClaw should rely on it rather than trying to reproduce its own loading or enablement logic.

### Bundled and installed plugins

OpenClaw supports more than one plugin source model.

At a high level, it recognizes:

- native plugins with `openclaw.plugin.json` and a runtime module
- bundled plugins shipped with OpenClaw
- installed plugins and additional plugin paths configured by the user
- bundle-compatible layouts for external plugin ecosystems

The key takeaway for PimClaw is that OpenClaw already expects plugins to be discoverable, inspectable, and manageable as first-class runtime artifacts.

### Enablement and policy

OpenClaw plugin config supports host-level enablement and policy controls, including:

- global plugin enable or disable
- allowlists and denylists
- per-plugin entry enablement
- per-plugin config blocks
- slot ownership for memory and context-engine plugins
- subagent override policy for trusted plugins

This reinforces an important design rule:

- OpenClaw owns trust and runtime policy
- PimClaw should plug into that model instead of introducing parallel trust controls when avoidable

### Diagnostics and contract testing

OpenClaw has extensive contract tests and diagnostics around plugin behavior.

The repository contains tests for:

- plugin SDK entrypoints
- plugin registration contracts
- plugin API guardrails
- plugin package/public surface boundaries
- bundled plugin metadata behavior

The practical meaning is that the OpenClaw side of the integration is comparatively mature and constrained. PimClaw should adapt itself to that mature host contract.

### Practical implications for PimClaw

The plugin feature research suggests several practical rules for PimClaw development:

1. keep PimClaw as a native plugin-first design
2. use OpenClaw service lifecycle for background runtime ownership
3. treat PimClaw tools as OpenClaw session tools, not standalone RPC endpoints first
4. move toward OpenClaw-native config integration over time
5. avoid duplicating host concerns such as loading, enablement, or trust policy

## Agent Model

In OpenClaw, an agent is a named runtime profile.

An agent is not just a model choice. It is the combination of:

- an `agentId`
- a workspace and instruction context
- model defaults and thinking defaults
- tool policy
- sandbox policy
- subagent policy
- session namespace

Examples of agent ids are values like `main` or `research`.

Sessions belong to agents. OpenClaw stores agent-scoped session keys in the form:

```text
agent:<agentId>:<sessionKey>
```

This separation matters:

- the agent defines the runtime identity and configuration
- the session defines the current conversation state and history

One agent can have many sessions.

## Workspace Model

OpenClaw uses an agent workspace as instruction and memory context.

The normal agent workspace can contain files such as:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- optional memory files

This is important because an OpenClaw agent is partly defined by its workspace, not only by config.

## Subagent Model

In OpenClaw, a subagent is a spawned child run created from within another agent run.

The most useful short definition is:

> A subagent is an isolated child session used for delegated background work.

Subagents run in their own session. The canonical session shape is:

```text
agent:<agentId>:subagent:<uuid>
```

OpenClaw treats subagents as a controlled delegation mechanism, not as unconstrained recursive agents.

### Why subagents exist

Subagents are meant for:

- parallel work
- long-running or slow work
- isolated task execution
- orchestrator and worker patterns

They let a parent run continue or finish while child work proceeds in the background.

### How subagents are spawned

The main tool is `sessions_spawn`.

For this repository, the important native runtime is:

- `runtime: "subagent"`

OpenClaw also supports `runtime: "acp"`, but that is a separate harness path and should not be confused with native subagents.

### Subagent isolation

Subagents are intentionally isolated.

They have:

- their own session history
- their own token usage
- their own lifecycle tracking as background tasks
- restricted tool access by default
- configurable sandbox inheritance or sandbox requirements

They do not simply share the parent transcript as if they were another turn in the same session.

### Announce-back behavior

When a subagent completes, it does not behave like a normal user-facing session by default. Instead, it runs an announce flow back to its requester.

At a high level:

- the child run finishes
- OpenClaw builds a structured completion payload
- the result is announced back to the requester context
- top-level requesters can then deliver a normal user-facing response

For nested subagents, results flow back up the chain one level at a time.

### Depth and role model

OpenClaw has an explicit depth model for subagents.

- depth 0: main agent session
- depth 1: subagent
- depth 2: sub-subagent

By default, depth is limited so that subagents cannot keep spawning more children.

When configured with `maxSpawnDepth >= 2`, OpenClaw enables an orchestrator pattern:

- main session spawns an orchestrator subagent
- orchestrator subagent spawns leaf worker subagents

OpenClaw also stores role and control metadata for sessions so capabilities are not inferred only from the session key shape.

Important roles are:

- `main`
- `orchestrator`
- `leaf`

Important control scopes are:

- `children`
- `none`

The practical rule is:

- main and orchestrator sessions can manage children
- leaf sessions cannot

### Tool policy for subagents

OpenClaw intentionally restricts subagent tools.

By default, subagents do not receive the full session-control surface. In particular, session management tools are restricted unless explicitly allowed by role and depth.

When depth-1 orchestrators are enabled, they can receive selected management tools such as:

- `sessions_spawn`
- `subagents`
- `sessions_list`
- `sessions_history`

Leaf workers remain restricted.

### Persistent subagent sessions

Subagents are not only one-shot workers.

OpenClaw supports two important spawn modes:

- `mode: "run"` for one-shot background work
- `mode: "session"` for persistent child sessions

When supported by a channel adapter, thread-bound child sessions can keep future user messages routed to the same subagent session.

## Relationship Between Agent and Subagent

The clean distinction to remember is:

- an agent is a named runtime profile
- a subagent is a spawned child session running under an agent profile

A subagent is not a different host runtime and not a free-form extra process model. It is a controlled OpenClaw session type for delegated work.

## PimClaw in One View

PimClaw is a domain-specific orchestration plugin for OpenClaw.

Its current purpose is to orchestrate LLM deployment operations through a small multi-agent subsystem running inside the OpenClaw process.

The main PimClaw components are:

- `HeadAgent`
- `SchedulerAgent`
- `WorkerAgent`
- `TaskStatusRecorder`
- `AgentRegistry`

## PimClaw Runtime Model

When the PimClaw plugin starts inside OpenClaw, it creates and manages a background service that boots its internal agents.

Current startup shape:

1. create `AgentRegistry`
2. initialize `TaskStatusRecorder`
3. initialize and run `SchedulerAgent`
4. initialize and run `HeadAgent`

The plugin also registers PimClaw tools so normal OpenClaw agent sessions can interact with it.

Examples include:

- `pimclaw_route_task`
- `pimclaw_health`
- `pimclaw_list_tasks`
- `pimclaw_list_agents`

OpenClaw agent sessions can call those tools, but PimClaw itself remains a plugin-owned orchestration subsystem.

## PimClaw Agent Responsibilities

### HeadAgent

The HeadAgent is the decision-making component.

Its intended job is to:

- observe runtime metrics from external MCP services such as Grafana
- analyze snapshots for anomalies
- decide whether corrective work should be planned
- create tasks through the task recorder

The current repository implementation already contains the observe-think-decide loop shape, but metric collection is still mocked rather than fully wired to real MCP services.

### TaskStatusRecorder

The TaskStatusRecorder is the persistent task state authority.

It is responsible for:

- storing tasks
- updating task lifecycle state
- persisting tasks to disk
- recovering and expiring stale tasks on startup

This component is central to PimClaw because all orchestration flows pass through task state.

### SchedulerAgent

The SchedulerAgent bridges planned work and execution.

It is responsible for:

- polling ready tasks
- enforcing concurrency limits
- moving tasks through scheduling states
- dispatching task execution

The current implementation has the scheduling loop and status transitions, but the actual worker launch path is still incomplete.

### WorkerAgent

The WorkerAgent is intended to execute one task.

Its intended job is to:

- mark a task running
- call the external execution MCP service
- record success or failure
- apply retry logic when appropriate

The WorkerAgent class exists, but full end-to-end wiring from the scheduler into real execution is not yet complete.

## OpenClaw and PimClaw Relationship

The relationship should be understood as a host-and-plugin boundary.

OpenClaw owns:

- plugin lifecycle
- config loading and runtime policy
- tool exposure to agent sessions
- state directory conventions
- delivery and broader runtime concerns

PimClaw owns:

- deployment orchestration logic
- task planning and task execution state
- PimClaw-specific health and status tools
- its internal orchestration agents

This means PimClaw should prefer OpenClaw-native integration patterns instead of inventing parallel host infrastructure.

## How OpenClaw Agents Interact with PimClaw

An OpenClaw agent session can use PimClaw tools to request orchestration work.

Typical interaction flow:

1. an OpenClaw agent receives a user request such as scaling or restarting a deployment
2. the agent calls a PimClaw tool such as `pimclaw_route_task`
3. PimClaw records the task
4. PimClaw scheduler logic picks it up
5. PimClaw worker logic eventually executes and records the result
6. the OpenClaw agent can inspect progress through PimClaw status tools

This is an important boundary:

- OpenClaw agents are consumers of PimClaw's tool surface
- PimClaw is the orchestration backend behind those tools

## Current State of PimClaw

The current PimClaw codebase appears to be a solid orchestration skeleton with real persistence and testing support, but with some important integration gaps.

What already exists:

- correct OpenClaw plugin entry shape
- service lifecycle wiring
- persistent task recorder
- internal registry and health model
- scheduler loop structure
- worker abstraction
- test coverage and developer documentation

What is still partial or placeholder:

- HeadAgent metrics are currently mocked
- MCP service command paths are placeholders
- scheduler-to-worker execution wiring is incomplete
- configuration manager exists but is not yet wired into runtime agent setup

## Development Guidance

When working on PimClaw, the following assumptions should stay stable:

1. OpenClaw is the host platform and source of truth for lifecycle and runtime policy.
2. PimClaw is an in-process OpenClaw plugin.
3. OpenClaw agents and sessions are distinct from PimClaw internal agents.
4. OpenClaw subagents are a host-level delegation mechanism and are conceptually different from PimClaw's own Head, Scheduler, and Worker classes.
5. If PimClaw later uses OpenClaw subagents directly, that should be a deliberate design choice rather than an accidental overlap in naming.

## Most Important Mental Model

The shortest useful summary is:

- OpenClaw is the host runtime and control plane.
- OpenClaw agents are named runtime profiles with sessions.
- OpenClaw subagents are isolated spawned child sessions for delegated work.
- PimClaw is a native OpenClaw plugin that provides a deployment-orchestration subsystem through its own internal orchestration agents and tool surface.
