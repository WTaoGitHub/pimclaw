# PimClaw — Requirements Specification

**Project**: PimClaw (Pagoda Inference Model Claw)
**Version**: 0.1.0
**Date**: 2026-03-30
**Author**: Bati / AI-assisted

---

## 1. Executive Summary

PimClaw is a multi-agent AI system designed to manage the lifecycle of LLM inference model deployments on Kubernetes. It operates as an orchestrator of specialized sub-agents, each consuming external services via the Model Context Protocol (MCP). A human operator communicates with PimClaw through natural language conversation to query, analyze, and optimize inference model deployments across heterogeneous GPU hardware.

The system is built as an OpenClaw plugin for native integration, while exposing all capabilities via MCP for portability to other frameworks (CrewAI, LangGraph, AutoGen, etc.).

---

## 2. Glossary

| Term | Definition |
|------|-----------|
| **Pagoda** | Internal branding for the inference model performance optimization platform |
| **Claw** | An agent, or group of agents, in the PimClaw system |
| **PimClaw Master** | The top-level orchestrator agent that creates, supervises, and coordinates sub-agents |
| **MCP** | Model Context Protocol — an open standard for tool/agent interoperability |
| **OpenClaw** | The host agent framework (TypeScript/Node.js) providing multi-channel AI assistant infrastructure |
| **vLLM** | Open-source LLM inference engine used to serve models |
| **TTFT** | Time To First Token (ms) — latency before first token is generated |
| **TPOT** | Time Per Output Token (ms) — per-token generation latency |
| **QPS** | Queries Per Second — request-level throughput |
| **Throughput** | Tokens per second — token-level throughput |
| **Tensor Parallelism (TP)** | Splitting model layers across multiple GPUs to reduce latency |
| **Pipeline Parallelism (PP)** | Splitting model stages across GPU groups to fit larger models |
| **Data Parallelism (DP)** | Running multiple model replicas to scale throughput |

---

## 3. Stakeholders

| Stakeholder | Role | Interest |
|-------------|------|----------|
| MLOps / Platform Engineer | Primary user | Queries performance data, requests analysis, applies deployment recommendations |
| ML Engineer | Secondary user | Evaluates model configurations for specific scenarios |
| Infrastructure Team | Consumer | Acts on deployment recommendations (K8s parameter changes) |
| External Services (perf, mon, sim) | Dependency | Provide data and simulation capabilities via MCP |

---

## 4. System Context

```
┌─────────────────────────────────────────────────────────┐
│                     Human Operator                       │
│            (CLI / Web UI / Chat Channel)                  │
└─────────────────────┬───────────────────────────────────┘
                      │ natural language
                      ▼
┌─────────────────────────────────────────────────────────┐
│                   OpenClaw Gateway                        │
│         (WebSocket control plane + channels)              │
└─────────────────────┬───────────────────────────────────┘
                      │ plugin API
                      ▼
┌─────────────────────────────────────────────────────────┐
│                   PimClaw Plugin                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │              PimClaw Master Agent                  │  │
│  │  ┌─────────────┐ ┌────────┐ ┌──────────────┐     │  │
│  │  │ Orchestrator │ │ Router │ │  Supervisor   │     │  │
│  │  └──────┬──────┘ └───┬────┘ └──────┬───────┘     │  │
│  └─────────┼────────────┼─────────────┼─────────────┘  │
│            │            │             │                  │
│  ┌─────────▼────────────▼─────────────▼─────────────┐  │
│  │              Sub-Agent Registry                    │  │
│  │  ┌──────┐  ┌─────────┐  ┌─────┐  ┌─────┐        │  │
│  │  │ perf │  │ analyst │  │ mon │  │ sim │         │  │
│  │  └──┬───┘  └─────────┘  └──┬──┘  └──┬──┘        │  │
│  └─────┼───────────────────────┼────────┼───────────┘  │
└────────┼───────────────────────┼────────┼───────────────┘
         │ MCP                   │ MCP    │ MCP
         ▼                      ▼        ▼
┌────────────────┐  ┌──────────────┐  ┌──────────────┐
│  perf service  │  │ mon service  │  │ sim service  │
│  (PostgreSQL   │  │ (runtime     │  │ (config      │
│   benchmark    │  │  metrics)    │  │  simulator)  │
│   data)        │  │              │  │              │
└────────────────┘  └──────────────┘  └──────────────┘
         │                  │                │
         ▼                  ▼                ▼
   ┌──────────┐     ┌────────────┐    ┌──────────┐
   │PostgreSQL│     │ K8s cluster│    │Simulation│
   │   DB     │     │ (live pods)│    │  engine  │
   └──────────┘     └────────────┘    └──────────┘
```

**Key architectural principle**: PimClaw does NOT directly access databases, Kubernetes, or any infrastructure. All external interactions are mediated through MCP services, making PimClaw a pure orchestration and intelligence layer.

---

## 5. Functional Requirements

### FR-1: Multi-Agent Orchestration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | The master agent SHALL dynamically create sub-agents with specific roles (perf, analyst, mon, sim, custom) | Must |
| FR-1.2 | The master agent SHALL maintain a registry of all active sub-agents with their state (idle, running, error, terminated) | Must |
| FR-1.3 | The master agent SHALL terminate sub-agents on demand, cleanly disconnecting their MCP services | Must |
| FR-1.4 | The master agent SHALL reconfigure sub-agents (change MCP service connections, update prompts) without re-creation | Should |
| FR-1.5 | The system SHALL auto-create default agents (perf, analyst) on startup when configured | Should |

### FR-2: Task Routing

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | The router SHALL classify user intent from natural language and route to the appropriate sub-agent role | Must |
| FR-2.2 | The router SHALL support direct routing to a specific agent by ID | Must |
| FR-2.3 | The router SHALL support multi-step workflows (e.g., perf → analyst → recommendation) | Should |
| FR-2.4 | The router SHALL handle ambiguous queries by defaulting to the perf agent | Must |
| FR-2.5 | The router SHALL report when no suitable agent is running for a classified intent | Must |

### FR-3: Agent Supervision

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | The supervisor SHALL monitor sub-agent health (task count, error count, error rate, idle time) | Must |
| FR-3.2 | The supervisor SHALL generate health reports with issues classified by severity (warning, error) | Must |
| FR-3.3 | The supervisor SHALL flag agents with error rates exceeding 50% | Must |
| FR-3.4 | The supervisor SHALL flag agents idle for more than 30 minutes | Should |
| FR-3.5 | The supervisor SHALL select the healthiest agent when multiple agents serve the same role | Must |

### FR-4: MCP Service Integration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | Sub-agents SHALL connect to external MCP services via stdio transport | Must |
| FR-4.2 | The system SHALL support listing all tools available on a sub-agent's connected MCP services | Must |
| FR-4.3 | The system SHALL support calling any tool on a sub-agent's MCP service with arbitrary arguments | Must |
| FR-4.4 | The system SHALL handle MCP connection failures gracefully and report errors to the agent state | Must |
| FR-4.5 | The system SHALL manage multiple MCP client connections per sub-agent | Should |

### FR-5: External MCP Services (Dependencies)

#### FR-5.1: perf Service (Performance Data)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1.1 | The perf service SHALL provide MCP tools to query historical performance benchmark data from PostgreSQL | Must |
| FR-5.1.2 | The performance data schema SHALL include: model_name, engine_name, device_type, node_num, device_per_node, scenario, dtype, quantization, gpu_memory_utilization, parallelism configs (TP/PP/DP), ttft, tpot, qps, throughput, deployment command, max_model_len, max_num_seqs, container_image, cpu, memory | Must |
| FR-5.1.3 | The perf service SHALL support filtering by model_name, device_type, scenario, and engine_name | Must |
| FR-5.1.4 | The perf service SHALL support listing distinct models, devices, and scenarios | Should |

**Known data scope** (from `perfllm_202603301503.csv`):

| Model | Device | Scenario |
|-------|--------|----------|
| Qwen/Qwen3-235B-A22B | nvidia/h800 | vibe-coding, summary |
| Qwen/Qwen3-32B | ascend/910b4 | chat |
| Qwen/QwQ-32B | ascend/910b4 | chat |
| deepseek-ai/DeepSeek-R1-Distill-Qwen-32B | ascend/910b4 | chat |
| Qwen/Qwen2.5-VL-72B-Instruct | ppu/zw810e | chat |

#### FR-5.2: mon Service (Runtime Monitoring) — Future

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.2.1 | The mon service SHALL provide MCP tools to query real-time performance metrics from running K8s deployments | Future |
| FR-5.2.2 | The mon service SHALL support latency, throughput, error rate, GPU memory, and queue depth metrics | Future |
| FR-5.2.3 | The mon sub-agent SHALL detect anomalies (>20% deviation from baseline) and report them | Future |

#### FR-5.3: sim Service (Simulation) — Future

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.3.1 | The sim service SHALL accept a deployment configuration and simulate its runtime performance | Future |
| FR-5.3.2 | The sim service SHALL return predicted TTFT, TPOT, QPS, throughput for the given configuration | Future |
| FR-5.3.3 | The sim sub-agent SHALL compare simulated vs. current production metrics before recommending changes | Future |

### FR-6: Performance Analysis

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.1 | The analyst agent SHALL compare configurations for the same model across different parallelism strategies | Must |
| FR-6.2 | The analyst agent SHALL identify optimal configurations given a model, device, and scenario | Must |
| FR-6.3 | The analyst agent SHALL consider scenario-specific priorities (chat: low latency; summary: high throughput) | Must |
| FR-6.4 | The analyst agent SHALL detect anomalous or suboptimal configurations | Should |
| FR-6.5 | The analyst agent SHALL produce deployment recommendations with reasoning | Must |

### FR-7: Conversation Interface

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-7.1 | Users SHALL interact with PimClaw via natural language through OpenClaw's chat channels (CLI, Web UI, WhatsApp, Telegram, etc.) | Must |
| FR-7.2 | The system SHALL present performance data in clear, tabular format when appropriate | Should |
| FR-7.3 | The system SHALL provide actionable recommendations with reasoning, not just raw data | Must |

### FR-8: MCP Server (Portability)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-8.1 | PimClaw SHALL expose all master agent tools via an MCP server for framework-agnostic consumption | Must |
| FR-8.2 | The MCP server SHALL be runnable standalone (outside OpenClaw) via `npm run mcp:serve` | Must |
| FR-8.3 | The MCP server SHALL be compatible with MCP inspector and any MCP-compliant client | Must |

---

## 6. Non-Functional Requirements

### NFR-1: Portability

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-1.1 | Core agent logic (tools, prompts, orchestration) SHALL be decoupled from OpenClaw-specific APIs | Must |
| NFR-1.2 | The system SHALL be migratable to other frameworks (CrewAI, LangGraph, AutoGen) by consuming the MCP server | Must |
| NFR-1.3 | No OpenClaw-specific imports SHALL exist in the master, router, supervisor, or MCP modules | Must |

### NFR-2: Reliability

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-2.1 | MCP client connection failures SHALL NOT crash the master agent | Must |
| NFR-2.2 | Individual sub-agent failures SHALL be isolated and not affect other agents | Must |
| NFR-2.3 | The system SHALL gracefully shutdown all MCP connections on termination | Must |

### NFR-3: Security

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-3.1 | No direct database access from PimClaw agents (all data via MCP services) | Must |
| NFR-3.2 | No raw shell execution capabilities exposed to agents | Must |
| NFR-3.3 | MCP service credentials SHALL be passed via environment variables, not hardcoded | Must |
| NFR-3.4 | Tool policy pipeline SHALL control which tools are available in which contexts | Should |

### NFR-4: Extensibility

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-4.1 | New agent roles SHALL be addable by defining a role name, system prompt, and MCP service configuration | Must |
| NFR-4.2 | Custom agents with user-provided prompts SHALL be supported | Should |
| NFR-4.3 | New MCP services SHALL be connectable without code changes (configuration-driven) | Must |

### NFR-5: Performance

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-5.1 | Agent creation SHALL complete within 5 seconds (excluding MCP service startup) | Should |
| NFR-5.2 | Task routing classification SHALL complete within 10ms | Should |
| NFR-5.3 | Health report generation SHALL complete within 10ms | Should |

### NFR-6: Testability

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-6.1 | All core modules SHALL have unit tests (Vitest) | Must |
| NFR-6.2 | Orchestrator, Router, and Supervisor SHALL be testable without MCP service connections | Must |
| NFR-6.3 | Test coverage SHALL be maintained as new features are added | Should |

---

## 7. Data Requirements

### DR-1: Performance Benchmark Schema

The following schema represents the data available from the perf MCP service, based on observed production data (`perfllm_202603301503.csv`):

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Unique record identifier |
| model_name | string | Full model identifier (e.g., "Qwen/Qwen3-235B-A22B") |
| engine_name | string | Inference engine (e.g., "vllm") |
| device_type | string | GPU hardware (e.g., "nvidia/h800", "ascend/910b4", "ppu/zw810e") |
| node_num | integer | Number of nodes |
| device_per_node | integer | GPUs per node |
| scenario | string | Use case (e.g., "chat", "vibe-coding", "summary") |
| dtype | string | Data type (e.g., "bfloat16") |
| quantization | string? | Quantization method (nullable) |
| gpu_memory_utilization | float | Target GPU memory usage (0.0–1.0) |
| data_parallel_size | integer? | Number of data-parallel replicas |
| pipeline_parallel_size | integer? | Number of pipeline stages |
| tensor_parallel_size | integer? | Number of tensor-parallel GPUs |
| enable_expert_parallel | boolean? | Expert parallelism for MoE models |
| enable_chunked_prefill | boolean? | Chunked prefill optimization |
| ttft | float | Time to first token (ms) |
| tpot | float | Time per output token (ms) |
| qps | float | Queries per second |
| throughput | float | Tokens per second |
| command | string | vLLM launch command template |
| max_model_len | integer | Maximum context window |
| concurrency_when_max_len | integer? | Concurrency at max context |
| max_num_seqs | integer? | Maximum concurrent sequences |
| container_image | string | Container image (e.g., "vllm:0.13.0") |
| task_id | string? | Associated benchmark task ID |
| cpu | integer | CPU cores allocated |
| memory | integer | Memory allocated (GiB) |

### DR-2: Metric Interpretation Rules

| Metric | Direction | Interactive Priority | Batch Priority |
|--------|-----------|---------------------|----------------|
| TTFT | Lower is better | HIGH | Low |
| TPOT | Lower is better | HIGH | Medium |
| QPS | Higher is better | Medium | HIGH |
| Throughput | Higher is better | Medium | HIGH |
| GPU Memory Utilization | 0.90–0.96 optimal | Medium | Medium |

---

## 8. Interface Requirements

### IR-1: OpenClaw Plugin Interface

PimClaw registers with OpenClaw as a plugin via `openclaw.plugin.json` manifest and provides:
- **8 agent tools** exposed to the OpenClaw agent for use during conversation
- **1 service** with start/stop lifecycle for agent auto-creation and shutdown
- **Configuration schema** for MCP service endpoints (perf, mon, sim)

### IR-2: Tools Exposed

| Tool | Input | Output |
|------|-------|--------|
| `pimclaw_create_agent` | role, name, mcpServices | Confirmation with agent ID |
| `pimclaw_list_agents` | (none) | Array of agent entries with definition + state |
| `pimclaw_terminate_agent` | agentId | Success/failure message |
| `pimclaw_agent_status` | agentId | Detailed agent entry JSON |
| `pimclaw_route_task` | task, targetAgentId? | Routing result with agent ID + role |
| `pimclaw_call_mcp_tool` | agentId, serviceName, toolName, args | MCP tool result content |
| `pimclaw_list_agent_tools` | agentId | Array of available MCP tools |
| `pimclaw_health` | (none) | Supervisor health report |

### IR-3: MCP Server Interface

All tools from IR-2 are also exposed via a standalone MCP server (`npm run mcp:serve`) using stdio transport for consumption by any MCP-compatible client.

### IR-4: Configuration

```yaml
# OpenClaw plugin config
plugins:
  pimclaw:
    autoCreateAgents: true
    perfMcp:
      command: "node"
      args: ["path/to/perf-mcp-server.js"]
      env:
        DATABASE_URL: "postgresql://..."
    monMcp:                      # optional, future
      command: "node"
      args: ["path/to/mon-mcp-server.js"]
    simMcp:                      # optional, future
      command: "python"
      args: ["path/to/sim-mcp-server.py"]
```

---

## 9. Constraints

| ID | Constraint |
|----|-----------|
| C-1 | Runtime: Node.js >= 22.16.0 |
| C-2 | Language: TypeScript (ES modules) |
| C-3 | Host framework: OpenClaw (TypeScript) for native integration |
| C-4 | MCP SDK: `@modelcontextprotocol/sdk` for both client and server |
| C-5 | PimClaw does not access databases, Kubernetes, or infrastructure directly — only via MCP services |
| C-6 | Each external MCP service (perf, mon, sim) is independently developed and deployed |
| C-7 | LLM provider is managed by OpenClaw (provider-agnostic); PimClaw does not manage LLM API keys |

---

## 10. Assumptions

| ID | Assumption |
|----|-----------|
| A-1 | The perf MCP service exists and provides tools for querying PostgreSQL performance data |
| A-2 | The perf MCP service schema matches the `perfllm_202603301503.csv` structure |
| A-3 | The mon and sim MCP services will follow the same stdio MCP transport pattern |
| A-4 | OpenClaw is installed and configured as the host environment |
| A-5 | The human operator has domain knowledge of LLM inference deployment |
| A-6 | GPU hardware (H800, Ascend 910B, PPU ZW810E) is provisioned and accessible via K8s |
| A-7 | Model artifacts are already available (Hugging Face Hub or local storage) |

---

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|-----------|
| R-1 | perf MCP service not yet implemented | High | High | PimClaw architecture is testable without it; agents degrade gracefully when MCP unavailable |
| R-2 | MCP protocol incompatibility between services | Low | Medium | Use official `@modelcontextprotocol/sdk` on both sides |
| R-3 | OpenClaw plugin API changes in future versions | Medium | Medium | Core logic is decoupled; only `src/index.ts` depends on OpenClaw types |
| R-4 | Router misclassifies user intent | Medium | Low | Users can route directly by agent ID; router patterns are refinable |
| R-5 | MCP service process crashes | Medium | Medium | Supervisor detects errors; agents can be re-created with same config |

---

## 12. Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-1 | PimClaw plugin loads in OpenClaw without errors | `openclaw gateway --verbose` shows "pimclaw: plugin registered" |
| AC-2 | Chat: "What models run on H800?" routes to perf and returns data | Manual test via OpenClaw chat |
| AC-3 | Chat: "Compare Qwen3-235B-A22B configurations" triggers analyst agent | Manual test |
| AC-4 | Chat: "Best config for Qwen3-32B on Ascend 910B" chains perf → analyst | Manual test |
| AC-5 | MCP Inspector lists all 8 tools | `npx @modelcontextprotocol/inspector` against `npm run mcp:serve` |
| AC-6 | Unit tests pass (29+ tests) | `npm test` exits 0 |
| AC-7 | TypeScript compiles without errors | `npm run lint` exits 0 |
| AC-8 | Agent creation and termination works | Unit test: create, verify registry, terminate, verify removal |
| AC-9 | Supervisor detects unhealthy agents | Unit test: simulate errors, verify report |
| AC-10 | Router correctly classifies perf/analyst/mon/sim intents | Unit test: intent classification with keyword patterns |

---

## 13. Future Scope (Out of v0.1)

| Feature | Description | Depends On |
|---------|-------------|-----------|
| K8s Deployer Agent | Sub-agent that applies recommended configuration changes to K8s deployments via kubectl/K8s API MCP | K8s MCP service |
| Automated Optimization Loop | mon detects degradation → perf fetches data → analyst recommends → sim validates → deployer applies | All 4 MCP services |
| Multi-model Scheduling | Optimize across multiple models sharing the same GPU cluster | Advanced analyst logic |
| Cost Modeling | Factor GPU-hour costs into recommendations | Cost data source |
| Historical Trend Analysis | Track performance changes over time, detect regression | Time-series perf data |
| Agent Persistence | Save/restore agent registry across restarts | SQLite or file-based store |
| Web Dashboard | Visual dashboard for agent status, performance trends, active deployments | Web UI framework |
