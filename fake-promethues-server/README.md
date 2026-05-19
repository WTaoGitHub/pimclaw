# Fake Prometheus Server (Go)

A cloud-ready fake Prometheus API server for PimClaw testing.

It implements key Prometheus endpoints used by `pimclaw_query_metrics`:
- `GET /api/v1/query`
- `GET /api/v1/query_range`
- `GET /-/healthy`
- `GET /-/ready`
- `GET /api/v1/status/config`
- `GET /_fake/status` (custom debug endpoint)
- `POST /_fake/action` or `POST /_fake/actions` (custom remediation endpoint)
- `POST /_fake/mode` (custom normal/anomaly mode switch endpoint)

The server stores in-memory time-series and continuously generates data every 15s.
On startup it pre-fills a rolling 24-hour history for all six PimClaw metrics:
`ttft`, `tpot`, `qps`, `throughput`, `gpu_utilization`, and `error_rate`.
That is `4 * 60 * 24 = 5760` points per metric. As new samples are generated,
the oldest samples are dropped.

The server starts in `NORMAL` mode and emits stable healthy LLM-serving metrics.
It switches modes only through explicit control APIs:

```bash
curl -s -X POST http://127.0.0.1:9090/_fake/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"normal"}'

curl -s -X POST http://127.0.0.1:9090/_fake/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"anomaly"}'
```

Switching mode immediately backfills the most recent five minutes of stored
data, then the server continues generating one new point every 15 seconds.
Older history remains in the one-day rolling buffer until it naturally ages out.

Switching to `ANOMALY` mode randomly selects one or two incident metrics from
`ttft`, `tpot`, `throughput`, `gpu_utilization`, and `error_rate`. Only the
selected metrics become bad; the other metrics remain healthy context signals.
The selected keys are returned in `anomaly_metrics` from `/_fake/status` and
the mode-switch response. Switching back to `NORMAL` clears `anomaly_metrics`
and backfills the latest five minutes with healthy points.

Metric targets:

| Metric | Normal target | Anomaly target | Very bad reference |
|--------|---------------|----------------|--------------------|
| TTFT | `< 200 ms` | `> 10s` | `> 30s` |
| TPOT | `< 20 ms/token` | `> 500 ms/token` | `> 1,200 ms/token` |
| QPS | stable load around `12 req/s` | not selected by anomaly mode | near-zero request flow |
| Throughput | `> 40 tok/sec/user` | `< 1.5 tok/sec/user` | `0 tokens/sec` |
| GPU Util | `80%-95%` | `< 70%` | `100% locked or 0%` |
| Error Rate | `< 0.01%` | `> 10%` | `> 25%` |

## LLM Deployment Metadata

The fake server supplies deployment metadata in metric labels, `/_fake/status`,
and `vllm:gpu_info` query responses so PimClaw can attach runtime hardware
metadata to anomaly events.

Defaults:

| Field | Default |
|-------|---------|
| deployment name | `Qwen/Qwen3-32B` |
| model name | `Qwen/Qwen3-32B` |
| hardware_name | `NVIDIA H800_SXM` |

Configure with environment variables:

```bash
FAKE_DEPLOYMENT_NAME="my-deployment"
FAKE_MODEL_NAME="Qwen/Qwen3-32B"
FAKE_HARDWARE_NAME="NVIDIA H800_SXM"
```

Example GPU metadata query:

```bash
curl -sG http://127.0.0.1:9090/api/v1/query \
  --data-urlencode 'query=vllm:gpu_info'
```

## Fake Remediation Control

The fake server can simulate a deployment action fixing the issue. Call the action
endpoint with any supported action:

```bash
curl -s -X POST http://127.0.0.1:9090/_fake/action \
  -H 'Content-Type: application/json' \
  -d '{"action":"restart","deploymentName":"minimax-m25-tp8ep"}'
```

Supported action names:
- `restart`
- `reconfig` / `reconfigure`
- `scale-in` / `scale-down`
- `scale-out` / `scale-up`

After an action is accepted, the server behaves exactly like
`POST /_fake/mode {"mode":"normal"}`: it enters `NORMAL` mode, clears
`anomaly_metrics`, backfills the latest five minutes with healthy points, and
returns normal performance metrics.

## Local Run

```bash
cd fake-promethues-server
go run . --port 9090
```

Environment variable supported for cloud platforms:
- `PORT` (default: `9090`)
- `FAKE_DEPLOYMENT_NAME` (default: `Qwen/Qwen3-32B`) sets the Prometheus `model_name` / PimClaw deployment identifier
- `FAKE_MODEL_NAME` (default: `Qwen/Qwen3-32B`) sets the model label exposed by the fake server
- `FAKE_HARDWARE_NAME` (default: `NVIDIA H800_SXM`) sets the hardware metadata exposed by `vllm:gpu_info`
- `FAKE_NORMAL_RANDOMNESS` (default: `0.04`) controls how far normal windows vary around their normal baseline; `0` disables extra normal-window spread
- `FAKE_ANOMALY_RANDOMNESS` (default: `0.35`) controls how far anomaly cycles vary around their anomaly baseline; `0` disables extra anomaly spread
- `FAKE_FORCE_ANOMALY_EVERY_QUERY` is deprecated; use `POST /_fake/mode`

Flags:
- `--port`: listen port
- `--cycle-minutes`: deprecated compatibility flag

## Build and Validate

```bash
cd fake-promethues-server
gofmt -w main.go
go test ./...
go build ./...
./regression-promql.sh
```

## Quick Smoke Test

```bash
curl -s 'http://127.0.0.1:9090/api/v1/query_range?query=sum(rate(vllm:num_requests_total[5m]))&start=1710000000&end=1710000060&step=15'
```

For aggregated vLLM queries (like `sum(rate(...))`), response series uses empty `metric: {}` to mirror Prometheus behavior.

The regression helper checks the three PromQL shapes PimClaw depends on:
- aggregated series: `sum(rate(vllm:request_success_total[5m]))`
- direct metric series: `vllm:kv_cache_usage_perc`
- derived labeled series: `histogram_quantile(0.95, rate(vllm:time_to_first_token_seconds_bucket[5m]))`

## Container Image

Build:

```bash
cd fake-promethues-server
docker build -t fake-prometheus:latest .
```

Run:

```bash
docker run --rm -p 9090:9090 -e PORT=9090 fake-prometheus:latest

# Tune normal and anomaly volatility independently
docker run --rm -p 9090:9090 -e PORT=9090 -e FAKE_NORMAL_RANDOMNESS=0.02 -e FAKE_ANOMALY_RANDOMNESS=0.60 fake-prometheus:latest

# Switch modes at runtime
curl -s -X POST http://127.0.0.1:9090/_fake/mode -H 'Content-Type: application/json' -d '{"mode":"anomaly"}'
curl -s -X POST http://127.0.0.1:9090/_fake/mode -H 'Content-Type: application/json' -d '{"mode":"normal"}'
```

## Kubernetes Deployment

Template manifest is provided at:
- `k8s/fake-prometheus.yaml`

Update image before applying:

```bash
kubectl apply -f k8s/fake-prometheus.yaml
```

The manifest includes:
- Deployment + Service
- readiness/liveness probes
- CPU/memory requests and limits

## CI/CD Script (Private Cloud)

Use the repo-level deploy script:
- `cicd/deploy-fake-prometheus.sh`

Default target namespace is `baota-playground`.

Dry-run:

```bash
cicd/deploy-fake-prometheus.sh --dry-run
```

Build, push, and deploy:

```bash
cicd/deploy-fake-prometheus.sh --tag latest-test
```

Deploy an already-pushed image:

```bash
cicd/deploy-fake-prometheus.sh --skip-build --tag latest-test
```

Override image repository or namespace if needed:

```bash
cicd/deploy-fake-prometheus.sh --image-repo 10.1.112.238:8443/baota/fake-prometheus --namespace baota-playground --tag v1
```

## Integration Note

Point PimClaw Prometheus base URL to this service endpoint (for example, your in-cluster service or ingress URL) so `pimclaw_query_metrics` reads from the fake data source.
