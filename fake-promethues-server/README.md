# Fake Prometheus Server (Go)

A cloud-ready fake Prometheus API server for PimClaw testing.

It implements key Prometheus endpoints used by `pimclaw_query_metrics`:
- `GET /api/v1/query`
- `GET /api/v1/query_range`
- `GET /-/healthy`
- `GET /-/ready`
- `GET /api/v1/status/config`
- `GET /_fake/status` (custom debug endpoint)

The server stores in-memory time-series and continuously generates data every 15s.
It rotates through a 3-window cycle: `NORMAL-1 -> NORMAL-2 -> ANOMALY`.

For PimClaw usage, each new `query_range` cycle (detected by a new `end` timestamp)
advances one synthetic 5-minute window. This means consecutive
`pimclaw_query_metrics(rangeMinutes=5)` runs naturally compare as:
1. `NORMAL-1`
2. `NORMAL-2`
3. `ANOMALY`
4. repeats

Semantics of the first four calls:
1. First call: baseline 5-minute window (`NORMAL-1`)
2. Second call: similar baseline-like window (`NORMAL-2`)
3. Third call: strong change window (`ANOMALY`)
4. Fourth call: back to baseline-like (`NORMAL-1`)

Within one metrics collection cycle, multiple metric queries sharing the same `end`
stay in the same window, so all six metrics are consistent for that cycle.

## Local Run

```bash
cd fake-promethues-server
go run . --port 9090 --cycle-minutes 5
```

Environment variable supported for cloud platforms:
- `PORT` (default: `9090`)
- `FAKE_NORMAL_RANDOMNESS` (default: `0.04`) controls how far normal windows vary around their normal baseline; `0` disables extra normal-window spread
- `FAKE_ANOMALY_RANDOMNESS` (default: `0.35`) controls how far anomaly cycles vary around their anomaly baseline; `0` disables extra anomaly spread
- `FAKE_FORCE_ANOMALY_EVERY_QUERY` (default: `false`) alternates each query cycle between very high and very low metric windows so consecutive Head-agent reads diverge sharply and should always trigger anomaly detection

Flags:
- `--port`: listen port
- `--cycle-minutes`: minutes per cycle window (full cycle is 4x)

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

# Force every new query cycle to swing hard from the previous one
docker run --rm -p 9090:9090 -e PORT=9090 -e FAKE_FORCE_ANOMALY_EVERY_QUERY=true fake-prometheus:latest
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
