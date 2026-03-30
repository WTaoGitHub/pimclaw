Plan: PimClaw — Pagoda Inference Model Agent System
A TypeScript multi-agent system that natively integrates with OpenClaw. A master agent (PimClaw) creates, supervises, and manages specialized sub-agents that fetch LLM inference performance data from PostgreSQL, analyze it, and recommend deployment changes for Kubernetes-hosted inference models (vLLM on NVIDIA H800, Ascend 910B, etc.). Core logic is portable via MCP tool interfaces.

Phase 1: Project Scaffolding & OpenClaw Plugin
Initialize as an OpenClaw plugin with openclaw.plugin.json manifest, using definePluginEntry() from OpenClaw's plugin SDK
Define plugin entry point registering master agent tools, provider hooks, and CLI commands
Set up project structure:
src/master/ — orchestrator, router, supervisor
src/agents/data-fetcher/ — PostgreSQL query agent
src/agents/data-analyst/ — performance analysis agent
src/agents/k8s-deployer/ — K8s deployment agent (future)
src/db/ — PostgreSQL client and typed queries
src/mcp/ — MCP server for framework portability
src/types/ — shared types
Phase 2: Database Layer & Data Fetcher Agent
Define PostgreSQL schema matching the CSV structure (model_name, engine_name, device_type, parallelism configs, ttft, tpot, qps, throughput, etc.)
Implement data fetcher tools: query_model_performance, list_models, list_devices, get_performance_summary, import_csv — all following OpenClaw's AnyAgentTool interface
Write data fetcher system prompt describing role and output format
Phase 3: Data Analyst Agent
Implement analyst tools: compare_configurations, find_optimal_config, detect_anomalies, recommend_deployment
Write analyst prompt with domain knowledge (TTFT/TPOT lower=better, QPS/throughput higher=better, parallelism tradeoffs)
Phase 4: Master Agent (Orchestrator)
Implement Orchestrator: createAgent(), listAgents(), terminateAgent(), reconfigureAgent() — leveraging OpenClaw's task/session system
Implement Router: analyze user intent → route to correct sub-agent → chain multi-step workflows (fetch → analyze → recommend)
Implement Supervisor: health monitoring, auto-restart, status reporting
Register all master tools with OpenClaw plugin API (pimclaw_create_agent, pimclaw_list_agents, pimclaw_route_task, etc.)
Phase 5: MCP Server for Portability
Implement MCP server using @modelcontextprotocol/sdk exposing all tools — this is the migration layer enabling CrewAI, LangGraph, AutoGen, etc. to consume pimclaw capabilities without rewriting core logic
Phase 6: Conversation Interface
CLI: Use OpenClaw's built-in openclaw agent --message "..." — no custom work
API: MCP server doubles as API; optional REST/WebSocket wrapper
Web UI: OpenClaw's built-in UI handles this — no custom work
Relevant Files
OpenClaw plugin SDK: openclaw/src/plugin-sdk/plugin-entry.ts — definePluginEntry() pattern
Plugin API: openclaw/src/plugins/types.ts — OpenClawPluginApi, hooks, provider interface
Tool interface: openclaw/src/agents/pi-tools.ts — AnyAgentTool schema
System prompts: openclaw/src/agents/system-prompt.ts — prompt assembly reference
Task persistence: openclaw/src/tasks/task-registry.store.sqlite.ts — task schema
MCP integration: openclaw/src/mcp/ — MCP reference implementation
Performance data: perfllm_202603301503.csv — schema reference with columns like model_name, device_type, tensor_parallel_size, ttft, tpot, qps, throughput
Verification
Plugin loads in OpenClaw without errors via openclaw gateway
Chat: "What models run on H800?" → data fetcher returns results from PostgreSQL
Chat: "Compare Qwen3-235B configs" → analyst compares parallelism strategies
Chat: "Best config for Qwen3-32B on Ascend 910B for chat" → multi-step fetch→analyze→recommend
MCP inspector (npx @modelcontextprotocol/inspector) lists and calls all tools
Vitest unit tests for DB queries, tool handlers, and router logic
Decisions
TypeScript for native OpenClaw integration (user confirmed)
MCP as the portability layer — swap frameworks without rewriting tools
PostgreSQL for performance data; OpenClaw's SQLite for task/session state
K8s deployer deferred to future phase — architecture supports it via MCP client
Security: parameterized SQL queries, tool policy pipeline for access control
Further Considerations
PostgreSQL config: Plugin config schema with env var fallback (e.g., PIMCLAW_PG_URL)
K8s MCP: Future deployer agent will use an MCP client to communicate with a K8s MCP server — same tool pattern
CSV import: Provide an import_csv tool the agent can invoke on demand rather than auto-importing