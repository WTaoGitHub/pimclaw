# Building, Packaging & Delivering PimClaw

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | >= 22.16.0 |
| npm | >= 10 |
| TypeScript | >= 5.3 (installed as devDependency) |

## Building

### Full build

```bash
npm install        # install all dependencies
npm run build      # compile TypeScript → dist/
```

`tsc` compiles every `.ts` file under `src/` into `dist/` with:

- ES2022 target, Node16 module resolution
- `.js` — runtime code
- `.d.ts` + `.d.ts.map` — type declarations
- `.js.map` — source maps

### Watch mode (development)

```bash
npm run dev        # tsc --watch
```

### Verify the build

```bash
npm test           # run vitest (all src/**/*.test.ts)
npm run lint       # eslint src
```

## Project structure after build

```
pimclaw/
├── dist/                          # compiled output (git-ignored)
│   ├── index.js                   # main entry — re-exports + OpenClaw plugin default
│   ├── openclaw-plugin.js         # plugin entry with service + tools
│   ├── config-manager.js          # YAML config loader
│   ├── master/
│   │   ├── component-registry.js  # in-memory component status & health
│   │   ├── base-agent.js          # agent base class (Scheduler, Worker)
│   │   ├── anomaly-receiver.js    # validates LLM Head events, triggers Planner
│   │   ├── planner-trigger.js     # spawns Planner agent via OpenClaw API
│   │   ├── scheduler-agent.js     # task polling & concurrency
│   │   ├── task-status-recorder.js# task state machine + persistence
│   │   ├── worker-agent.js        # ephemeral task executor
│   │   ├── mcp-server.js          # MCP Server wrapper
│   │   └── cli.js                 # CLI tool
│   └── types/                     # type declarations
├── AGENTS.md                      # LLM Head & Planner agent definitions
├── openclaw.plugin.json           # OpenClaw plugin manifest
├── package.json
└── tsconfig.json
```

## Packaging

### For npm publish

Add the `files` field to `package.json` to keep the tarball lean (include only what's needed at runtime):

```json
{
  "files": [
    "dist",
    "openclaw.plugin.json"
  ]
}
```

Then:

```bash
npm run build
npm pack                   # creates pimclaw-1.0.0.tgz
```

Inspect what goes into the tarball:

```bash
npm pack --dry-run         # list all included files
```

### Publish to a registry

```bash
# npm public registry
npm publish

# private / scoped registry
npm publish --registry https://npm.example.com

# GitHub Packages
npm publish --registry https://npm.pkg.github.com
```

> **Checklist before publishing:**
> 1. `npm run build` succeeds with no errors
> 2. `npm test` passes (31 E2E + unit tests across 5 test files)
> 3. Version in `package.json` is bumped (`npm version patch|minor|major`)
> 4. `openclaw.plugin.json` contracts list matches the actual registered tools (10 tools)

## Delivering to OpenClaw

### Option 1 — Install from npm

```bash
openclaw plugin add pimclaw
```

### Option 2 — Install from a local path

```bash
openclaw plugin add /path/to/pimclaw
```

### Option 3 — Install into a Docker container

```bash
# 1. Build locally
npm run build

# 2. Copy into the container
docker cp . openclaw-container:/tmp/pimclaw

# 3. Install production dependencies inside the container
docker exec openclaw-container sh -c \
  'cd /tmp/pimclaw && npm install --production'

# 4. Register with --link (changes take effect without re-copy)
docker exec openclaw-container openclaw plugin add --link /tmp/pimclaw

# 5. Enable the plugin
docker exec openclaw-container openclaw plugin enable pimclaw
```

To update after code changes:

```bash
npm run build
docker cp . openclaw-container:/tmp/pimclaw
# OpenClaw picks up changes via the symlink — restart or reload
docker exec openclaw-container openclaw reload
```

### Option 4 — Reference in OpenClaw config

```json
{
  "plugins": [
    { "id": "pimclaw", "enabled": true }
  ]
}
```

### Verify installation

```bash
openclaw plugin list               # pimclaw should appear
openclaw plugin enable pimclaw     # if not enabled
```

Once activated, the `pimclaw-components` service starts automatically and the ten tools (`pimclaw_submit_anomalies`, `pimclaw_plan_task`, `pimclaw_route_task`, `pimclaw_health`, etc.) become available to all agent sessions. The LLM Head and Planner agents must also be configured in OpenClaw's agent runtime — see `AGENTS.md`.

## Compatibility

| Field | Value | Where |
|-------|-------|-------|
| Plugin API | `>= 2026.1.0` | `package.json` → `openclaw.compat.pluginApi` |
| Node.js | `>= 22.16.0` | `package.json` → `engines.node` |
| Module system | ESM (`"type": "module"`) | `package.json` |

## Quick reference

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Build | `npm run build` |
| Watch mode | `npm run dev` |
| Run tests | `npm test` |
| Lint | `npm run lint` |
| Pack tarball | `npm pack` |
| Publish | `npm publish` |
| CLI inspect | `npm run cli` / `node dist/master/cli.js` |