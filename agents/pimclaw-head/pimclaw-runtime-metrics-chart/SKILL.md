---
name: pimclaw-runtime-metrics-chart
description: Query PimClaw runtime Prometheus or fake-prometheus metrics and render human-friendly charts. Use when working in this PimClaw repo and asked to inspect, visualize, chart, plot, or compare runtime LLM deployment metrics such as TTFT, TPOT, QPS, throughput, GPU utilization, or error rate from Prometheus, fake-prometheus, or the same in-cluster path used by pimclaw_query_metrics. Also use when the user explicitly says Chinese scouting/status phrases such as "前去打探", "敌军动向", or "最新情况"; in PimClaw Head context these mean inspect current runtime metrics and report/chart the latest situation.
---

# PimClaw Runtime Metrics Chart

Use this skill to visualize live PimClaw metrics from the runtime Prometheus or fake Prometheus server. Prefer the bundled script so querying, unit conversion, and chart output stay consistent.

## Trigger Phrases

Treat these explicit user phrases as requests to invoke this skill:

- `前去打探`
- `敌军动向`
- `最新情况`

In PimClaw Head context, interpret them as: query configured fake/runtime Prometheus, render the runtime metrics chart, and summarize the latest LLM deployment situation.

## Default Workflow

1. Run `scripts/pimclaw_metrics_chart.py`.
2. If running inside the PimClaw pod, rely on the default config path `/home/node/.openclaw/openclaw.json`; the script reads the URL from PimClaw plugin config.
3. If `fakePrometheusRemediation.baseUrl` is set in `openclaw.json`, use it and ignore the real `prometheus.baseUrl`.
4. If running from a developer machine, pass `--via-pod` so the query executes from inside the running PimClaw pod, or pass `--base-url` for direct local access.
5. Use `--engine vllm` or `--engine sglang`; default is `vllm`.
6. Use `--deployment` when the user wants one deployment. Omit it for aggregated metrics or fake Prometheus defaults.
7. The script also fetches `gpu_info` when supported by the configured Prometheus source and prints it as `gpu_info` JSON. Use this to report deployment name, model name, and `hardware_name`.
8. The default query range is 10 minutes with 15-second samples, so each metric line has 40 points.
9. Return the generated PNG with Markdown image syntax if available. If PNG conversion is not available, return the SVG path.

Example:

```bash
python3 SKILL/pimclaw-runtime-metrics-chart/scripts/pimclaw_metrics_chart.py \
  --range-minutes 10 \
  --out fake-promethues-server/runtime-metrics-chart.svg
```

From outside the pod:

```bash
python3 SKILL/pimclaw-runtime-metrics-chart/scripts/pimclaw_metrics_chart.py \
  --via-pod \
  --namespace baota-playground \
  --pod pimclaw-75896475f6-j8qpz \
  --config cicd/openclaw.json \
  --range-minutes 10 \
  --out fake-promethues-server/runtime-metrics-chart.svg
```

Then show:

```md
![Runtime fake Prometheus metrics](/absolute/path/to/runtime-metrics-chart.svg.png)
```

## Defaults For This Repo

- Namespace: `baota-playground`
- PimClaw pod prefix: `pimclaw-`
- Runtime config path inside PimClaw pod: `/home/node/.openclaw/openclaw.json`
- Prometheus URL config lookup order:
  1. `plugins.entries.pimclaw.config.fakePrometheusRemediation.baseUrl`
  2. `plugins.entries.pimclaw.config.prometheus.baseUrl`
- When fake Prometheus is configured, treat it as authoritative and do not query the real Prometheus URL.
- Output: `fake-promethues-server/runtime-metrics-chart.svg`
- Default range: 10 minutes
- Sample step: 15 seconds
- Points per metric: 40
- Metrics: `ttft`, `tpot`, `qps`, `throughput`, `gpu_utilization`, `error_rate`
- Metadata: `gpu_info` with `deploymentName`, `modelName`, and `hardware_name` when available

## PromQL

The script uses the same metric names and PromQL shape as `src/master/prometheus-client.ts`.
For fake Prometheus, the same PromQL is acceptable because the fake server identifies the metric family from the query string.
For vLLM metadata, the script also queries `vllm:gpu_info`.

## Rendering

The script writes SVG using only Python standard library. It then attempts fast native PNG rendering with:

```bash
qlmanage -t -s 1600 -o <output-dir> <chart.svg>
```

If `qlmanage` is unavailable or fails, the script renders a simple PNG line chart with a pure-Python fallback. Prefer returning the PNG path whenever the script prints one.

## Interpretation

When summarizing, mention the latest values, whether the window looks normal or anomalous, and the `gpu_info` deployment/model/hardware metadata when present. For fake Prometheus, typical normal vLLM TTFT is around `0.12-0.15s`; anomaly TTFT may be much higher when `ttft` is one of the selected anomaly metrics.
