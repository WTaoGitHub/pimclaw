#!/usr/bin/env python3
"""Query PimClaw Prometheus metrics and render a compact SVG/PNG chart."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONFIG_PATHS = (
    "/home/node/.openclaw/openclaw.json",
    "cicd/openclaw.json",
    "openclaw.json",
)
DEFAULT_NAMESPACE = "baota-playground"
DEFAULT_OUT = "fake-promethues-server/runtime-metrics-chart.svg"


PROMQL: dict[str, dict[str, str]] = {
    "vllm": {
        "ttft": 'histogram_quantile(0.95, rate(vllm:time_to_first_token_seconds_bucket[5m]))',
        "tpot": 'histogram_quantile(0.95, rate(vllm:request_time_per_output_token_seconds_bucket[5m]))',
        "qps": "sum(rate(vllm:request_success_total[5m]))",
        "throughput": "sum(rate(vllm:generation_tokens_total[5m]))",
        "gpu_utilization": "vllm:kv_cache_usage_perc",
        "error_rate": 'sum(rate(vllm:request_success_total{finished_reason="error"}[5m])) / sum(rate(vllm:request_success_total[5m])) * 100',
    },
    "sglang": {
        "ttft": 'histogram_quantile(0.95, rate(sglang:time_to_first_token_seconds_bucket[5m]))',
        "tpot": "histogram_quantile(0.95, rate(sglang:inter_token_latency_seconds_bucket[5m]))",
        "qps": "sum(rate(sglang:num_requests_total[5m]))",
        "throughput": "sum(rate(sglang:generation_tokens_total[5m]))",
        "gpu_utilization": "sglang:token_usage",
        "error_rate": "sum(rate(sglang:num_aborted_requests_total[5m])) / sum(rate(sglang:num_requests_total[5m])) * 100",
    },
}


@dataclass(frozen=True)
class MetricSpec:
    key: str
    label: str
    color: str
    unit: str
    ratio_to_percent: bool = False


METRICS = [
    MetricSpec("ttft", "TTFT", "#d44a3a", "s"),
    MetricSpec("tpot", "TPOT", "#7a4cc2", "s/token"),
    MetricSpec("qps", "QPS", "#1872b8", "req/s"),
    MetricSpec("throughput", "Throughput", "#188f6a", "tokens/s"),
    MetricSpec("gpu_utilization", "GPU Utilization", "#b57900", "%", True),
    MetricSpec("error_rate", "Error Rate", "#5f6b7a", "%", True),
]


def run(args: list[str]) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def discover_pimclaw_pod(namespace: str) -> str:
    raw = run(["kubectl", "get", "pods", "-n", namespace, "-o", "json"])
    pods = json.loads(raw).get("items", [])
    for pod in pods:
        name = pod.get("metadata", {}).get("name", "")
        phase = pod.get("status", {}).get("phase")
        if name.startswith("pimclaw-") and phase == "Running":
            return name
    raise RuntimeError(f"no running pimclaw-* pod found in namespace {namespace}")


def read_config(path: str | None) -> dict[str, Any] | None:
    paths = [path] if path else list(DEFAULT_CONFIG_PATHS)
    for candidate in paths:
        if not candidate:
            continue
        p = Path(candidate).expanduser()
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    return None


def find_pimclaw_config(config: dict[str, Any]) -> dict[str, Any]:
    entries = config.get("plugins", {}).get("entries", {})
    return entries.get("pimclaw", {}).get("config", {})


def resolve_base_url(config_path: str | None, base_url: str | None) -> str:
    if base_url:
        return base_url
    config = read_config(config_path)
    if not config:
        searched = config_path or ", ".join(DEFAULT_CONFIG_PATHS)
        raise RuntimeError(f"no --base-url supplied and no openclaw config found at {searched}")
    pimclaw = find_pimclaw_config(config)
    for section in ("fakePrometheusRemediation", "prometheus"):
        value = pimclaw.get(section, {}).get("baseUrl")
        if value:
            return value
    raise RuntimeError("openclaw config does not contain pimclaw fakePrometheusRemediation.baseUrl or prometheus.baseUrl")


def resolve_engine(config_path: str | None, explicit_engine: str | None) -> str:
    if explicit_engine:
        return explicit_engine
    config = read_config(config_path)
    if config:
        value = find_pimclaw_config(config).get("prometheus", {}).get("engine")
        if isinstance(value, str) and value in PROMQL:
            return value
        if isinstance(value, list):
            for item in value:
                if item in PROMQL:
                    return item
    return "vllm"


def with_deployment(promql: str, deployment: str | None) -> str:
    if not deployment:
        return promql
    matcher = f'model_name="{deployment}"'
    metric_names = [
        "vllm:time_to_first_token_seconds_bucket",
        "vllm:request_time_per_output_token_seconds_bucket",
        "vllm:request_success_total",
        "vllm:generation_tokens_total",
        "vllm:kv_cache_usage_perc",
        "sglang:time_to_first_token_seconds_bucket",
        "sglang:inter_token_latency_seconds_bucket",
        "sglang:num_requests_total",
        "sglang:generation_tokens_total",
        "sglang:token_usage",
        "sglang:num_aborted_requests_total",
    ]
    out = promql
    for name in metric_names:
        out = out.replace(name + "{", name + "{" + matcher + ",")
        out = out.replace(name + "[", name + "{" + matcher + "}[")
        if out.endswith(name):
            out = out[: -len(name)] + name + "{" + matcher + "}"
    return out


def query_local(base_url: str, promql: str, start: int, end: int, step: int, timeout: int) -> dict[str, Any]:
    query = urllib.parse.urlencode({"query": promql, "start": start, "end": end, "step": step})
    with urllib.request.urlopen(f"{base_url.rstrip('/')}/api/v1/query_range?{query}", timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def query_via_pod(pod: str, namespace: str, base_url: str, promql: str, start: int, end: int, step: int) -> dict[str, Any]:
    raw = run(
        [
            "kubectl",
            "exec",
            "-n",
            namespace,
            pod,
            "--",
            "curl",
            "-sS",
            "--get",
            "--data-urlencode",
            f"query={promql}",
            "--data-urlencode",
            f"start={start}",
            "--data-urlencode",
            f"end={end}",
            "--data-urlencode",
            f"step={step}",
            f"{base_url.rstrip('/')}/api/v1/query_range",
        ]
    )
    start_idx = raw.find("{")
    if start_idx > 0:
        raw = raw[start_idx:]
    return json.loads(raw)


def extract_series(payload: dict[str, Any], spec: MetricSpec) -> list[tuple[float, float]]:
    results = payload.get("data", {}).get("result", [])
    if not results:
        return []
    values = results[0].get("values", [])
    out = []
    for ts, raw in values:
        try:
            val = float(raw)
        except (TypeError, ValueError):
            continue
        if math.isnan(val) or math.isinf(val):
            continue
        if spec.ratio_to_percent and val <= 1.0:
            val *= 100
        out.append((float(ts), val))
    return out


def fmt_value(value: float, spec: MetricSpec) -> str:
    if spec.unit == "%":
        return f"{value:.1f}%"
    if spec.key in {"ttft", "tpot"}:
        return f"{value:.3f}{spec.unit}"
    if spec.key == "throughput":
        return f"{value:.0f}{spec.unit}"
    return f"{value:.1f}{spec.unit}"


def esc(text: Any) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_svg(series: dict[str, list[tuple[float, float]]], out: Path, title: str, subtitle: str) -> None:
    width, height = 1200, 760
    ml, mt = 70, 78
    col_w = (width - ml - 30 - 36) / 2
    row_h = (height - mt - 54 - 36) / 3
    all_ts = [ts for points in series.values() for ts, _ in points]
    min_ts, max_ts = min(all_ts), max(all_ts)

    def sx(ts: float, x: float, w: float) -> float:
        return x + ((ts - min_ts) / ((max_ts - min_ts) or 1)) * w

    def sy(value: float, lo: float, hi: float, y: float, h: float) -> float:
        return y + h - ((value - lo) / ((hi - lo) or 1)) * h

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#fbfaf7"/>',
        f'<text x="{ml}" y="38" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#1f2933">{esc(title)}</text>',
        f'<text x="{ml}" y="62" font-family="Arial,sans-serif" font-size="13" fill="#64707d">{esc(subtitle)}</text>',
    ]

    for idx, spec in enumerate(METRICS):
        points = series.get(spec.key, [])
        if not points:
            continue
        vals = [v for _, v in points]
        col, row = idx % 2, idx // 2
        x, y = ml + col * (col_w + 36), mt + row * (row_h + 18)
        lo, hi = min(vals), max(vals)
        pad = (hi - lo) * 0.18 or hi * 0.1 or 1
        lo, hi = max(0, lo - pad), hi + pad
        gx, gy, gw, gh = x + 54, y + 40, col_w - 76, row_h - 62
        poly = " ".join(f"{sx(ts, gx, gw):.1f},{sy(v, lo, hi, gy, gh):.1f}" for ts, v in points)

        parts.append(f'<g><rect x="{x}" y="{y}" width="{col_w}" height="{row_h}" fill="#fff" stroke="#d7dde3" rx="6"/>')
        parts.append(f'<text x="{x + 14}" y="{y + 24}" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#24313f">{esc(spec.label)} ({esc(spec.unit)})</text>')
        parts.append(f'<text x="{x + col_w - 14}" y="{y + 24}" text-anchor="end" font-family="Arial,sans-serif" font-size="12" fill="#64707d">latest {esc(fmt_value(vals[-1], spec))}</text>')
        for k in range(4):
            yy = gy + gh * k / 3
            parts.append(f'<line x1="{gx}" y1="{yy}" x2="{gx + gw}" y2="{yy}" stroke="#eef1f4"/>')
        parts.append(f'<line x1="{gx}" y1="{gy + gh}" x2="{gx + gw}" y2="{gy + gh}" stroke="#cfd6dd"/>')
        parts.append(f'<line x1="{gx}" y1="{gy}" x2="{gx}" y2="{gy + gh}" stroke="#cfd6dd"/>')
        parts.append(f'<text x="{gx - 8}" y="{gy + 4}" text-anchor="end" font-family="Arial,sans-serif" font-size="10" fill="#6b7682">{esc(fmt_value(hi, spec))}</text>')
        parts.append(f'<text x="{gx - 8}" y="{gy + gh}" text-anchor="end" font-family="Arial,sans-serif" font-size="10" fill="#6b7682">{esc(fmt_value(lo, spec))}</text>')
        parts.append(f'<polyline fill="none" stroke="{spec.color}" stroke-width="2.5" points="{poly}"/>')
        for ts, v in points:
            parts.append(f'<circle cx="{sx(ts, gx, gw):.1f}" cy="{sy(v, lo, hi, gy, gh):.1f}" r="2.8" fill="{spec.color}"/>')
        parts.append("</g>")

    parts.append("</svg>")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(parts), encoding="utf-8")


def render_png_with_qlmanage(svg: Path) -> Path | None:
    if not shutil.which("qlmanage"):
        return None
    png = Path(str(svg) + ".png")
    if png.exists():
        png.unlink()
    try:
        subprocess.check_output(["qlmanage", "-t", "-s", "1600", "-o", str(svg.parent), str(svg)], stderr=subprocess.STDOUT, text=True)
    except subprocess.CalledProcessError:
        return None
    return png if png.exists() else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", help="Prometheus base URL. Overrides openclaw.json.")
    parser.add_argument("--config", help="Path to openclaw.json. Defaults to /home/node/.openclaw/openclaw.json inside the pod, then repo fallbacks.")
    parser.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    parser.add_argument("--pod")
    parser.add_argument("--via-pod", action="store_true")
    parser.add_argument("--engine", choices=sorted(PROMQL), help="Inference engine. Defaults to prometheus.engine from config, then vllm.")
    parser.add_argument("--deployment")
    parser.add_argument("--range-minutes", type=int, default=5)
    parser.add_argument("--step", type=int, default=30)
    parser.add_argument("--timeout", type=int, default=10)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    end = int(time.time())
    start = end - args.range_minutes * 60
    base_url = resolve_base_url(args.config, args.base_url)
    engine = resolve_engine(args.config, args.engine)
    pod = args.pod
    if args.via_pod and not pod:
        pod = discover_pimclaw_pod(args.namespace)

    collected: dict[str, list[tuple[float, float]]] = {}
    for spec in METRICS:
        promql = with_deployment(PROMQL[engine][spec.key], args.deployment)
        payload = (
            query_via_pod(pod, args.namespace, base_url, promql, start, end, args.step)
            if args.via_pod
            else query_local(base_url, promql, start, end, args.step, args.timeout)
        )
        collected[spec.key] = extract_series(payload, spec)

    if not any(collected.values()):
        raise RuntimeError("Prometheus returned no usable samples")

    out = Path(args.out).resolve()
    subtitle = f"{args.range_minutes}-minute query_range"
    if args.via_pod:
        subtitle += f" from pod {pod}"
    if args.deployment:
        subtitle += f" | deployment {args.deployment}"
    subtitle += f" | {engine} | {base_url}"
    render_svg(collected, out, "PimClaw Runtime Metrics", subtitle)
    png = render_png_with_qlmanage(out)

    latest = {}
    for spec in METRICS:
        points = collected.get(spec.key) or []
        if points:
            latest[spec.key] = fmt_value(points[-1][1], spec)
    print(json.dumps({"svg": str(out), "png": str(png) if png else None, "latest": latest}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
