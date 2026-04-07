Plan: PimClaw Head Agent — Prometheus/vLLM Metrics Integration
Add a pimclaw_query_metrics tool to the plugin that queries your Prometheus server's HTTP API directly. The Head agent (already registered with cron) calls this tool to fetch vLLM metrics, then uses its LLM reasoning to detect anomalies and submit them via pimclaw_submit_anomalies. No MCP server needed — just a direct HTTP tool with pre-built PromQL queries for vLLM.

Steps

Phase 1: Prometheus Metrics Tool
Create src/master/prometheus-client.ts — lightweight client wrapping Prometheus /api/v1/query and /api/v1/query_range. Uses native fetch() (Node 22). Type-safe response parsing.

Define vLLM PromQL query map — maps PimClaw's 6 metrics to vLLM Prometheus metrics:

PimClaw Metric	vLLM Prometheus Metric	PromQL
ttft	vllm:time_to_first_token_seconds	histogram_quantile(0.95, rate(..._bucket[5m]))
tpot	vllm:request_time_per_output_token_seconds	histogram_quantile(0.95, rate(..._bucket[5m]))
qps	vllm:request_success	sum(rate(...[5m]))
throughput	vllm:generation_tokens	sum(rate(...[5m]))
gpu_utilization	vllm:kv_cache_usage_perc	Direct gauge (KV cache as GPU proxy)
error_rate	Derived from vllm:request_success	error / total * 100
Allow overriding individual PromQL queries via plugin config for non-vLLM setups.

Register pimclaw_query_metrics tool in openclaw-plugin.ts — params: metrics? (which to fetch), deploymentName? (filter by model), rangeMinutes? (trend data). Returns structured JSON.

Add prometheus config section to openclaw.plugin.json — baseUrl (required), queryOverrides (optional per-metric PromQL), defaultLabels, timeoutMs.

Update Head agent system prompt — change "Collect from Grafana" → "Call pimclaw_query_metrics"

Phase 2: Agent & Plugin Config
Update Head agent tool access — add pimclaw_query_metrics to tools.allow in OpenClaw config
Update plugin manifest contracts — add pimclaw_query_metrics to contracts.tools[]
Phase 3: Testing & Deploy
Unit tests for prometheus-client — mock fetch, test PromQL map, error handling (parallel with step 9)
Integration test — mock Prometheus → Head queries metrics → detects anomaly → creates task (parallel with step 8)
Build & deploy to Docker — configure prometheus.baseUrl, run openclaw cron run <job-id> to test (depends on 1-7)
Relevant files

src/master/prometheus-client.ts — NEW: HTTP client + vLLM PromQL query map
openclaw-plugin.ts — add pimclaw_query_metrics tool, instantiate PrometheusClient
openclaw.plugin.json — add prometheus config, add tool to contracts
AGENTS.md — update Head agent system prompt
src/master/__tests__/prometheus-client.test.ts — NEW: unit tests
Verification

npm test — all existing + new tests pass
npm run build — compiles
Deploy to Docker, set prometheus.baseUrl to your Prometheus instance
openclaw cron run <pimclaw-head-monitor-id> — Head agent fetches real vLLM metrics and reasons about anomalies
Check pimclaw_list_tasks for any anomaly-triggered tasks
Decisions

Direct HTTP tool over MCP server — simpler, no extra process, scoped to plugin
vLLM PromQL defaults with override — works out-of-box for vLLM, configurable for others
P95 quantiles for TTFT/TPOT — catches tail latency
KV cache as GPU proxy — vLLM doesn't export raw GPU%, but KV cache saturation is the actual inference bottleneck
Further Considerations

GPU metrics: vLLM only exposes kv_cache_usage_perc. If you have dcgm-exporter or nvidia-gpu-exporter, we can use real GPU% via config override. Do you have one?
Multi-deployment: If running multiple vLLM instances, we can auto-discover by querying grouped by model_name label.
Prometheus auth: If your Prometheus is behind auth, we should add optional bearerToken or basic auth to the config.