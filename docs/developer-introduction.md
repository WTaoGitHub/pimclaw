# PimClaw Developer Introduction

## What PimClaw Is

PimClaw, short for Pagoda Inference Model Claw, is a multi-agent orchestration layer for LLM inference operations. It is designed to sit inside OpenClaw as a native plugin while also exposing its capabilities through MCP so the same orchestration model can be reused in other agent frameworks.

At a high level, PimClaw does three things:

1. Creates and manages specialized sub-agents.
2. Routes operator requests to the right agent based on intent.
3. Connects those agents to external MCP services that provide data or execution capabilities.

PimClaw is intentionally not the system that stores benchmark data, scrapes metrics, or changes Kubernetes state directly. It is the control and reasoning layer that coordinates those responsibilities through MCP-connected services.

## Why The Project Exists

Inference operations usually spread across several concerns:

- historical benchmark lookup
- runtime monitoring
- configuration simulation
- performance analysis and recommendation

Those concerns often live in different systems and require different reasoning patterns. PimClaw separates them into role-based agents so the system can grow without turning into a single overloaded prompt or tool bundle.

The initial target use case is performance management for model deployments running on heterogeneous accelerator hardware such as NVIDIA H800, Ascend 910B, and PPU ZW810E.

## Core Design Principles

### 1. OpenClaw-native, not OpenClaw-only

PimClaw integrates directly with OpenClaw through the plugin SDK, but its core functionality is also exposed as an MCP server. That gives the project two deployment modes:

- native plugin mode inside OpenClaw
- portable MCP server mode for any MCP-compatible framework

### 2. MCP-first boundaries

PimClaw does not assume direct ownership of every dependency. Instead, it treats external services as MCP endpoints. This keeps integration boundaries explicit and makes the orchestration layer easier to port.

### 3. Role-specific agents

Each sub-agent has a narrow role and a clear responsibility. The current roles are:

- `perf`: retrieves historical performance and benchmark data
- `analyst`: interprets data and produces recommendations
- `mon`: handles runtime monitoring workflows
- `sim`: handles simulation and what-if analysis

### 4. Human-in-the-loop operations

The project is designed for operators interacting through conversation. Natural language requests are translated into routing, tool use, and agent-level decisions by the PimClaw master components.

## System Architecture

PimClaw has four main layers.

### Plugin Layer

The OpenClaw plugin entry lives in `src/index.ts`.

This layer is responsible for:

- registering PimClaw tools with OpenClaw
- registering the PimClaw lifecycle service
- parsing plugin configuration
- auto-creating default agents when configured

### Master Layer

The master layer lives under `src/master/` and contains the control logic.

- `orchestrator.ts`: owns agent lifecycle, registry state, MCP connectivity, and task delegation
- `router.ts`: classifies requests and chooses the best target role or agent
- `supervisor.ts`: evaluates health, error rates, and idle status across agents

This is the layer to read first if you want to understand PimClaw behavior.

### MCP Integration Layer

The MCP layer lives under `src/mcp/`.

- `client.ts`: connects PimClaw agents to external MCP services
- `server.ts`: exposes PimClaw's own management capabilities as MCP tools

This is the portability boundary of the project.

### Domain Types And Prompts

Support code is organized into:

- `src/types/agents.ts`: agent state, role, lifecycle, and MCP service types
- `src/types/models.ts`: performance-domain data types
- `src/agents/prompts.ts`: role-specific prompts and master-agent framing
- `src/config.ts`: plugin configuration parsing

## Runtime Model

When PimClaw starts inside OpenClaw, the typical flow is:

1. OpenClaw loads the PimClaw plugin entry.
2. PimClaw parses plugin configuration.
3. The plugin service starts and optionally auto-creates default agents.
4. Sub-agents connect to configured MCP services.
5. An operator submits a conversational request.
6. PimClaw routes the request to the best sub-agent or service tool path.
7. The result is returned back through OpenClaw.

In standalone mode, PimClaw skips the OpenClaw plugin lifecycle and exposes its management tools directly through its own MCP server.

## What PimClaw Owns And What It Does Not

PimClaw owns:

- agent creation and termination
- agent registry state
- task routing
- MCP connection management
- health and supervision logic
- OpenClaw tool registration
- MCP exposure of PimClaw management tools

PimClaw does not own:

- benchmark database storage
- runtime metrics collection infrastructure
- Kubernetes deployment execution
- simulator implementation details
- model-serving engine logic

Those responsibilities are delegated to external systems accessed through MCP.

## Current Tool Surface

PimClaw registers the following management tools:

- `pimclaw_list_agents`
- `pimclaw_create_agent`
- `pimclaw_terminate_agent`
- `pimclaw_agent_status`
- `pimclaw_route_task`
- `pimclaw_call_mcp_tool`
- `pimclaw_list_agent_tools`
- `pimclaw_health`

These tools are the primary interface for both OpenClaw integration and standalone MCP portability.

## Repository Map

For day-to-day development, these are the most important files:

- `src/index.ts`: plugin entry and lifecycle wiring
- `src/master/orchestrator.ts`: central control plane
- `src/master/router.ts`: request classification
- `src/master/supervisor.ts`: health logic
- `src/mcp/client.ts`: outbound MCP integration
- `src/mcp/server.ts`: inbound MCP exposure
- `src/agents/prompts.ts`: role prompts
- `src/config.ts`: config parsing
- `openclaw.plugin.json`: manifest and UI-facing config schema
- `docs/requirements.md`: full requirements and acceptance criteria
- `docs/install.md`: install and integration guide

## Development Workflow

The current local workflow is straightforward.

### Install

```bash
npm install
```

### Type-check

```bash
npm run lint
```

### Run tests

```bash
npm test
```

### Build

```bash
npm run build
```

### Run standalone MCP server

```bash
npx tsx src/mcp/server.ts
```

## How To Approach Changes

When adding or changing behavior, use these guidelines.

### If you are changing routing behavior

Start with `src/master/router.ts` and its tests. Routing bugs are usually caused by overlapping intent patterns or weighting mistakes.

### If you are changing agent lifecycle or connectivity

Start with `src/master/orchestrator.ts` and `src/mcp/client.ts`. Most operational behavior flows through these two files.

### If you are changing OpenClaw integration

Start with `src/index.ts` and `openclaw.plugin.json`. Keep plugin registration and manifest configuration aligned.

### If you are adding a new agent role

You will likely need to update:

- `src/types/agents.ts`
- `src/agents/prompts.ts`
- `src/master/router.ts`
- `src/master/orchestrator.ts`
- `src/mcp/server.ts`
- relevant tests

## Testing Strategy

The project currently has focused unit coverage around the main control surfaces:

- orchestrator behavior
- routing decisions
- supervisor reporting
- MCP tool exposure

If you change behavior in those areas, update or extend the corresponding tests first. This codebase is small enough that regressions usually show up quickly when the control flow or tool contracts shift.

## Known Constraints

- PimClaw currently relies on external MCP services for domain data and action execution.
- OpenClaw SDK typing is supported locally through ambient declarations so PimClaw can be developed even when the OpenClaw host checkout is not fully built.
- The plugin manifest and the runtime config parser must stay in sync.

## Recommended Reading Order

For a new developer joining the project, this reading order is usually the fastest:

1. `docs/developer-introduction.md`
2. `docs/requirements.md`
3. `docs/install.md`
4. `src/index.ts`
5. `src/master/orchestrator.ts`
6. `src/master/router.ts`
7. `src/mcp/server.ts`

That sequence gives you the conceptual model first, then the operating model, then the code path that matters most.

## Near-Term Development Priorities

The most natural next areas of growth are:

- richer agent-to-agent coordination patterns
- more robust MCP service health and retry logic
- stronger runtime monitoring and simulation integrations
- operator-facing workflows for recommendations and follow-up actions
- packaging and publishing improvements for external plugin consumption

## Summary

PimClaw is best understood as a control plane for inference-operations intelligence. It is not a monolithic agent and not a direct executor of all platform operations. Its value comes from coordinating specialized agents, keeping tool boundaries explicit through MCP, and fitting naturally into OpenClaw while remaining portable beyond it.