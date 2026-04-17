---
name: prometheus-exploration
description: 'Query and explore Prometheus metrics for LLM inference deployments (vLLM/SGLang). Use when asked to check metrics, explore Prometheus, debug metrics issues, query deployment performance, or investigate LLM latency/throughput/errors.'
argument-hint: 'Optional: deployment name, metric name, or time range'
---

# Prometheus Exploration for PimClaw

## When to Use

- When asked to "check metrics", "query Prometheus", "explore metrics"
- When debugging why metrics are empty or incorrect
- When asked about a deployment's performance (TTFT, TPOT, QPS, throughput)
- When investigating latency spikes, error rates, or GPU utilization
- When comparing performance across deployments or engines


## Prerequisites

- Prometheus server accessible (configured in `openclaw.json` under `prometheus.baseUrl`)
- Current known instance: `http://192.168.4.6:31904`
- vLLM and/or SGLang inference engines exposing metrics


## Prometheus REST API

### Endpoints

| Endpoint | Purpose | Returns |
|----------|---------|---------|
| `/api/v1/query?query=<promql>` | Instant query (current value) | Single `[timestamp, value]` per series |
| `/api/v1/query_range?query=<promql>&start=<unix>&end=<unix>&step=<sec>` | Range query (time-series) | Array of `[timestamp, value]` pairs per series |
| `/api/v1/label/__name__/values` | List all metric names | String array |
| `/api/v1/targets` | Active scrape targets | Target metadata |


## Engine-Specific Metric Prefixes

vLLM metrics use `vllm:` prefix. SGLang metrics use `sglang:` prefix. Key differences:

| Metric | vLLM PromQL | SGLang PromQL |
|--------|-------------|---------------|
| **TTFT** (P95) | `histogram_quantile(0.95, rate(vllm:time_to_first_token_seconds_bucket[5m]))` | `histogram_quantile(0.95, rate(sglang:time_to_first_token_seconds_bucket[5m]))` |
| **TPOT** (P95) | `histogram_quantile(0.95, rate(vllm:request_time_per_output_token_seconds_bucket[5m]))` | `histogram_quantile(0.95, rate(sglang:inter_token_latency_seconds_bucket[5m]))` |
| **QPS** | `sum(rate(vllm:request_success_total[5m]))` | `sum(rate(sglang:num_requests_total[5m]))` |
| **Throughput** | `sum(rate(vllm:generation_tokens_total[5m]))` | `sum(rate(sglang:generation_tokens_total[5m]))` |
| **GPU Utilization** | `vllm:kv_cache_usage_perc` | `sglang:token_usage` |
| **Error Rate** | `sum(rate(vllm:request_success_total{finished_reason="error"}[5m])) / sum(rate(vllm:request_success_total[5m])) * 100` | `sum(rate(sglang:num_aborted_requests_total[5m])) / sum(rate(sglang:num_requests_total[5m])) * 100` |


## Common Exploration Queries

### Step 1: Discover what's available

List all vLLM metrics:
```bash
curl -s 'http://PROMETHEUS:PORT/api/v1/label/__name__/values' | python3 -c "
import json,sys
names = json.load(sys.stdin)['data']
vllm = [n for n in names if n.startswith('vllm:')]
sglang = [n for n in names if n.startswith('sglang:')]
print(f'vllm: {len(vllm)} metrics, sglang: {len(sglang)} metrics')
for n in sorted(vllm): print(f'  {n}')
for n in sorted(sglang): print(f'  {n}')
"
```

### Step 2: Find active deployments

```bash
curl -s 'http://PROMETHEUS:PORT/api/v1/query?query=vllm:num_requests_running' | python3 -c "
import json,sys
r = json.load(sys.stdin)['data']['result']
for x in r:
    print(f\"  {x['metric'].get('model_name','?')} = {x['value'][1]} running\")
"
```

### Step 3: Get current state of a deployment

Replace `DEPLOYMENT` with the model_name label value:

```bash
python3 -c "
import json, urllib.request, urllib.parse
BASE = 'http://PROMETHEUS:PORT/api/v1/query'
D = 'DEPLOYMENT'

def qi(promql):
    url = f'{BASE}?query={urllib.parse.quote(promql)}'
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())['data']['result']

queries = {
    'kv_cache': f'vllm:kv_cache_usage_perc{{model_name=\"{D}\"}}',
    'running': f'vllm:num_requests_running{{model_name=\"{D}\"}}',
    'waiting': f'vllm:num_requests_waiting{{model_name=\"{D}\"}}',
    'prompt_tokens': f'vllm:prompt_tokens_total{{model_name=\"{D}\"}}',
    'gen_tokens': f'vllm:generation_tokens_total{{model_name=\"{D}\"}}',
}
for name, q in queries.items():
    r = qi(q)
    val = r[0]['value'][1] if r else 'N/A'
    print(f'  {name}: {val}')
"
```

### Step 4: Get time-series data (2-hour window)

```bash
python3 -c "
import json, urllib.request, urllib.parse, time
BASE_R = 'http://PROMETHEUS:PORT/api/v1/query_range'
D = 'DEPLOYMENT'
NOW = int(time.time()); START = NOW - 7200; STEP = 60

def qr(promql):
    p = urllib.parse.urlencode({'query': promql, 'start': START, 'end': NOW, 'step': STEP})
    with urllib.request.urlopen(f'{BASE_R}?{p}', timeout=15) as r:
        return json.loads(r.read())['data']['result']

def summarize(results):
    if not results: return 'no_data'
    values = results[0].get('values', [])
    non_nan = [float(v) for _, v in values if v != 'NaN']
    if not non_nan: return 'all_NaN'
    return f'min={min(non_nan):.4f} max={max(non_nan):.4f} avg={sum(non_nan)/len(non_nan):.4f} pts={len(non_nan)}'

metrics = {
    'ttft_p95': f'histogram_quantile(0.95, rate(vllm:time_to_first_token_seconds_bucket{{model_name=\"{D}\"}}[5m]))',
    'tpot_p95': f'histogram_quantile(0.95, rate(vllm:request_time_per_output_token_seconds_bucket{{model_name=\"{D}\"}}[5m]))',
    'qps':      f'sum(rate(vllm:request_success_total{{model_name=\"{D}\"}}[5m]))',
    'throughput':f'sum(rate(vllm:generation_tokens_total{{model_name=\"{D}\"}}[5m]))',
    'kv_cache':  f'vllm:kv_cache_usage_perc{{model_name=\"{D}\"}}',
}
for name, q in metrics.items():
    print(f'  {name}: {summarize(qr(q))}')
"
```

### Step 5: Request breakdown by finish reason

```bash
curl -s 'http://PROMETHEUS:PORT/api/v1/query?query=vllm:request_success_total{model_name="DEPLOYMENT"}' | python3 -c "
import json,sys
r = json.load(sys.stdin)['data']['result']
total = 0
for x in r:
    reason = x['metric'].get('finished_reason','?')
    count = int(float(x['value'][1]))
    total += count
    print(f'  {reason}: {count}')
print(f'  total: {total}')
"
```

### Step 6: Prefix cache hit rate

```bash
python3 -c "
import json, urllib.request, urllib.parse
BASE = 'http://PROMETHEUS:PORT/api/v1/query'
D = 'DEPLOYMENT'
def qi(q):
    url = f'{BASE}?query={urllib.parse.quote(q)}'
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())['data']['result']
h = float(qi(f'vllm:prefix_cache_hits_total{{model_name=\"{D}\"}}')[0]['value'][1])
t = float(qi(f'vllm:prefix_cache_queries_total{{model_name=\"{D}\"}}')[0]['value'][1])
print(f'  hits: {int(h)}, queries: {int(t)}, hit_rate: {h/t*100:.2f}%')
"
```


## Using pimclaw_query_metrics Tool (In-Container)

The plugin provides the `pimclaw_query_metrics` tool which wraps these Prometheus queries.

### Tool Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `metrics` | `string[]` | Which metrics: ttft, tpot, qps, throughput, gpu_utilization, error_rate. Default: all |
| `deploymentName` | `string` | Filter by model_name label |
| `engine` | `string \| string[]` | Filter to engine(s): vllm, sglang. Default: all configured |
| `rangeMinutes` | `number` | Return time-series pairs over N minutes (~15s step). Use 5 for Head Agent |

### Response Format

Results are **grouped by engine**:
```json
{
  "vllm": {
    "ttft": [{ "metric": { "model_name": "deployment-name" }, "values": [[ts, "0.12"], ...] }],
    "tpot": [...],
    "qps": [...],
    "throughput": [...],
    "gpu_utilization": [...],
    "error_rate": [...]
  },
  "sglang": {
    "ttft": [],
    ...
  }
}
```

- Empty arrays mean no deployments on that engine
- Each result has `metric.model_name` = deployment identifier
- With `rangeMinutes`: returns `values` array of `[timestamp, value]` pairs
- Without `rangeMinutes`: returns `value` as single `[timestamp, value]`

### Testing via CLI (inside container)

```bash
docker exec CONTAINER sh -c 'openclaw agent --agent pimclaw-head --message "Call pimclaw_query_metrics with rangeMinutes 5 and report what you see" --json 2>&1'
```


## Metrics Data Storage Format

When the tool executes, it persists snapshots to MetricsStore as `MetricsRecord`:

```json
{
  "ts": 1776159905666,
  "metrics": [
    {
      "deployments": "minimax-m27",
      "engine": "sglang",
      "ttft": 0,
      "tpot": 0,
      "qps": 0,
      "throughput": 0,
      "gpu_utilization": 0,
      "error_rate": 0
    },
    {
      "deployments": "minimax-m25-tp8ep",
      "engine": "vllm",
      "ttft": 0.242,
      "tpot": 0.099,
      "qps": 0.034,
      "throughput": 2.433,
      "gpu_utilization": 0.008,
      "error_rate": 0
    }
  ]
}
```

Each metrics entry includes:
- `deployments`: model_name label from Prometheus results
- `engine`: which inference engine (vllm or sglang)
- Six core metric values (scalar, extracted from latest data point)


## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| All metrics empty | Wrong engine configured | Check `engine` in config vs actual Prometheus metric prefixes. Run discovery query (Step 1) |
| `model_name` not found | Deployment name mismatch | Query `vllm:num_requests_running` to see actual label values |
| NaN values in time-series | No requests in rate window | Normal for idle deployments. Use `rate(...[15m])` for longer window |
| Timeout errors | Prometheus overloaded or unreachable | Check `baseUrl` connectivity, increase `timeoutMs` in config |
| Metrics exist but tool returns empty | Label filter mismatch | Check `defaultLabels` in config — extra labels narrow the query |


## Additional vLLM Metrics (Beyond Core 6)

These are available in Prometheus but not queried by the default tool:

| Metric | PromQL |
|--------|--------|
| E2E Latency P95 | `histogram_quantile(0.95, rate(vllm:e2e_request_latency_seconds_bucket{model_name="D"}[5m]))` |
| Queue Time P95 | `histogram_quantile(0.95, rate(vllm:request_queue_time_seconds_bucket{model_name="D"}[5m]))` |
| Prefill Time P95 | `histogram_quantile(0.95, rate(vllm:request_prefill_time_seconds_bucket{model_name="D"}[5m]))` |
| Decode Time P95 | `histogram_quantile(0.95, rate(vllm:request_decode_time_seconds_bucket{model_name="D"}[5m]))` |
| Running Requests | `vllm:num_requests_running{model_name="D"}` |
| Waiting Requests | `vllm:num_requests_waiting{model_name="D"}` |
| Total Prompt Tokens | `vllm:prompt_tokens_total{model_name="D"}` |
| Total Gen Tokens | `vllm:generation_tokens_total{model_name="D"}` |
| Preemptions | `vllm:num_preemptions_total{model_name="D"}` |
| Prefix Cache Hits | `vllm:prefix_cache_hits_total{model_name="D"}` |
| Prefix Cache Queries | `vllm:prefix_cache_queries_total{model_name="D"}` |
| Request Success by Reason | `vllm:request_success_total{model_name="D"}` (labels: finished_reason=stop/length/abort) |


## Label Injection

The `injectLabels()` function adds label matchers to PromQL queries:

```
injectLabels('rate(vllm:x_total[5m])', { model_name: 'llama' })
→ 'rate(vllm:x_total{model_name="llama"}[5m])'
```

Use `deploymentName` parameter on the tool to filter by `model_name`, or `defaultLabels` in config for global filters (e.g., namespace, cluster).
