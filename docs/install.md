# PimClaw — Install & Integration Guide

## Prerequisites

- Node.js ≥ 22.16
- An existing [OpenClaw](https://github.com/nicepkg/openclaw) instance (source checkout)
- One or more MCP services for PimClaw sub-agents to consume (e.g. `perf` MCP server)

---

## 1. Clone PimClaw next to your OpenClaw checkout

```bash
# Example layout:
# ~/projects/openclaw/        ← OpenClaw source
# ~/projects/pimclaw/         ← PimClaw plugin (this repo)

cd ~/projects
git clone <pimclaw-repo-url> pimclaw
cd pimclaw
```

## 2. Point PimClaw at your local OpenClaw

Edit `package.json` and update the `openclaw` devDependency path:

```jsonc
"devDependencies": {
  "openclaw": "file:/absolute/path/to/openclaw",
  // ...
}
```

Then install:

```bash
npm install
```

## 3. Verify the build

```bash
npm run lint    # TypeScript type-check (zero errors expected)
npm test        # 29 tests, all should pass
npm run build   # Emits dist/
```

## 4. Register PimClaw as an OpenClaw extension

For a ready-to-edit starting point, use [pimclaw.config.example.yaml](../pimclaw.config.example.yaml) or [pimclaw.config.example.json](../pimclaw.config.example.json).

Add PimClaw to OpenClaw's configuration. In your OpenClaw config file (typically `~/.config/openclaw/config.yaml` or the equivalent), add:

```yaml
plugins:
  pimclaw:
    enabled: true
    path: /absolute/path/to/pimclaw
    config:
      autoCreateAgents: true
      perfMcp:
        command: "node"
        args: ["path/to/perf-mcp-server.js"]
        env:
          DATABASE_URL: "postgresql://user:pass@host:5432/perfdb"
      # monMcp:               # optional — runtime monitor
      #   command: "node"
      #   args: ["path/to/mon-mcp-server.js"]
      # simMcp:               # optional — simulator
      #   command: "node"
      #   args: ["path/to/sim-mcp-server.js"]
```

Alternatively, if OpenClaw supports extension discovery via workspace layout, symlink PimClaw into the extensions directory:

```bash
ln -s /absolute/path/to/pimclaw /path/to/openclaw/extensions/pimclaw
```

## 5. Start OpenClaw

Start (or restart) OpenClaw. PimClaw registers:

| Registered Item | Type    | Description |
|----------------|---------|-------------|
| `pimclaw_list_agents` | Tool | List all sub-agents |
| `pimclaw_create_agent` | Tool | Create a new sub-agent (perf/analyst/mon/sim) |
| `pimclaw_terminate_agent` | Tool | Terminate a sub-agent |
| `pimclaw_agent_status` | Tool | Get agent details |
| `pimclaw_route_task` | Tool | Route a task to the best sub-agent |
| `pimclaw_call_mcp_tool` | Tool | Call a tool on a sub-agent's MCP service |
| `pimclaw_list_agent_tools` | Tool | Discover tools available to an agent |
| `pimclaw_health` | Tool | Health report for all sub-agents |
| `pimclaw` | Service | Lifecycle management (auto-creates agents on start) |

## 6. Verify in OpenClaw

Once OpenClaw is running, test the plugin:

```
> List all PimClaw agents
> Create a perf agent called "GPU Perf Tracker"
> What is the throughput of Qwen3-235B-A22B on H800?
```

---

## Standalone MCP Server (without OpenClaw)

PimClaw can also run as a standalone MCP server for integration with any MCP-compatible framework:

```bash
npx tsx src/mcp/server.ts
```

This exposes the same 7 tools over MCP stdio transport. Configure your MCP client to connect:

```json
{
  "mcpServers": {
    "pimclaw": {
      "command": "npx",
      "args": ["tsx", "/path/to/pimclaw/src/mcp/server.ts"]
    }
  }
}
```

---

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoCreateAgents` | `boolean` | `true` | Auto-create default agents (perf, analyst) on startup |
| `perfMcp.command` | `string` | — | Command to start the perf MCP server |
| `perfMcp.args` | `string[]` | — | Arguments for the perf MCP command |
| `perfMcp.env` | `Record<string,string>` | — | Environment variables for the perf MCP process |
| `monMcp.command` | `string` | — | Command for the runtime monitor MCP server |
| `monMcp.args` | `string[]` | — | Arguments for the mon MCP command |
| `monMcp.env` | `Record<string,string>` | — | Environment variables for the mon MCP process |
| `simMcp.command` | `string` | — | Command for the simulator MCP server |
| `simMcp.args` | `string[]` | — | Arguments for the sim MCP command |
| `simMcp.env` | `Record<string,string>` | — | Environment variables for the sim MCP process |

---

## Project Structure

```
pimclaw/
├── src/
│   ├── index.ts              Plugin entry (OpenClaw SDK integration)
│   ├── config.ts             Configuration parser
│   ├── agents/
│   │   └── prompts.ts        Role-specific system prompts
│   ├── master/
│   │   ├── orchestrator.ts   Agent lifecycle & task routing
│   │   ├── router.ts         Intent classification
│   │   └── supervisor.ts     Health monitoring
│   ├── mcp/
│   │   ├── client.ts         MCP client (connects to external services)
│   │   └── server.ts         MCP server (exposes PimClaw tools)
│   └── types/
│       ├── agents.ts         Agent type definitions
│       └── models.ts         Performance data types
├── types/
│   └── openclaw-plugin-sdk.d.ts   Ambient type declarations for OpenClaw SDK
├── openclaw.plugin.json      Plugin manifest with config schema
├── docs/
│   ├── requirements.md       Full requirements specification
│   └── install.md            This file
├── package.json
└── tsconfig.json
```
