# PimClaw

PimClaw, short for Pagoda Inference Model Claw, is a multi-agent orchestration layer for LLM inference operations. It runs as a native OpenClaw plugin and can also expose its management surface through MCP for use in other MCP-compatible frameworks.

## What The Project Does

PimClaw acts as the control plane for inference-operations workflows. It is responsible for:

- creating and supervising specialized sub-agents
- routing operator requests to the appropriate agent
- connecting agents to external MCP services
- exposing management tools through OpenClaw and MCP

PimClaw does not directly own benchmark storage, runtime metrics infrastructure, Kubernetes execution, or simulator implementation logic. Those concerns remain in external systems accessed through MCP.

## Current Agent Roles

- `perf`: historical performance and benchmark retrieval
- `analyst`: performance interpretation and recommendation
- `mon`: runtime monitoring workflows
- `sim`: simulation and what-if analysis

## Repository Structure

- `src/`: runtime implementation
- `docs/`: developer and operator documentation
- `types/`: ambient type declarations for local development
- `openclaw.plugin.json`: plugin manifest and configuration schema

## Quick Start

### Install dependencies

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

## Documentation

- [Developer Introduction](docs/developer-introduction.md)
- [Requirements Specification](docs/requirements.md)
- [Install & Integration Guide](docs/install.md)
- [OpenClaw Integration Notes](docs/howtointegratewithopenclaw.md)

## Where To Start In Code

If you are new to the repository, start with these files:

1. `src/index.ts`
2. `src/master/orchestrator.ts`
3. `src/master/router.ts`
4. `src/mcp/server.ts`

## Development Notes

- The project targets Node.js 22.16+.
- OpenClaw SDK typing is supported locally through ambient declarations in `types/openclaw-plugin-sdk.d.ts`.
- The runtime config parser in `src/config.ts` must remain aligned with `openclaw.plugin.json`.

## Contributing

Use a small, focused branch for each change. Keep behavior changes, documentation changes, and refactors separated unless they are directly coupled.

Before opening a review:

```bash
npm run lint
npm test
npm run build
```

Review expectations:

- describe the problem being solved, not only the code that changed
- call out any config, schema, or tool-surface changes explicitly
- update tests when control flow, routing behavior, or MCP contracts change
- keep `src/config.ts` and `openclaw.plugin.json` aligned when configuration changes are introduced

If a change affects OpenClaw integration, include the expected operator-visible result in the review description, for example a new tool, updated config key, or changed startup behavior

## Summary

PimClaw is best understood as a control plane for inference-operations intelligence. It coordinates specialized agents, keeps integration boundaries explicit through MCP, and is designed to fit naturally into OpenClaw while remaining portable beyond it.