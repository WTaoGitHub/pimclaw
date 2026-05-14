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
import zlib
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

GPU_INFO_PROMQL: dict[str, str] = {
    "vllm": "vllm:gpu_info",
}


@dataclass(frozen=True)
class MetricSpec:
    key: str
    label: str
    color: str
    unit: str
    y_max: float
    y_interval: float
    ratio_to_percent: bool = False


METRICS = [
    MetricSpec("ttft", "TTFT", "#d44a3a", "s", 50, 1),
    MetricSpec("tpot", "TPOT", "#7a4cc2", "s/token", 2.5, 0.05),
    MetricSpec("qps", "QPS", "#1872b8", "req/s", 50, 1),
    MetricSpec("throughput", "Throughput", "#188f6a", "tokens/s", 40, 0.8),
    MetricSpec("gpu_utilization", "GPU Utilization", "#b57900", "%", 100, 2, True),
    MetricSpec("error_rate", "Error Rate", "#5f6b7a", "%", 100, 2, True),
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
        "vllm:gpu_info",
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


def query_instant_local(base_url: str, promql: str, timeout: int) -> dict[str, Any]:
    query = urllib.parse.urlencode({"query": promql})
    with urllib.request.urlopen(f"{base_url.rstrip('/')}/api/v1/query?{query}", timeout=timeout) as resp:
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


def query_instant_via_pod(pod: str, namespace: str, base_url: str, promql: str) -> dict[str, Any]:
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
            f"{base_url.rstrip('/')}/api/v1/query",
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


def extract_gpu_info(payload: dict[str, Any]) -> list[dict[str, str]]:
    out = []
    for item in payload.get("data", {}).get("result", []):
        labels = item.get("metric", {})
        if not isinstance(labels, dict):
            continue
        model_name = str(labels.get("model_name") or labels.get("deployment_name") or labels.get("model") or "")
        model = str(labels.get("model") or labels.get("modelName") or model_name)
        hardware = str(labels.get("hardware_name") or labels.get("hardwareName") or labels.get("gpu_type") or labels.get("gpuType") or labels.get("modelName") or "")
        if not any((model_name, model, hardware)):
            continue
        out.append(
            {
                "deploymentName": model_name,
                "modelName": model,
                "hardware_name": hardware,
            }
        )
    return out


def metadata_summary(gpu_info: list[dict[str, str]]) -> str:
    if not gpu_info:
        return ""
    first = gpu_info[0]
    parts = []
    if first.get("deploymentName"):
        parts.append(f"deployment {first['deploymentName']}")
    if first.get("modelName") and first.get("modelName") != first.get("deploymentName"):
        parts.append(f"model {first['modelName']}")
    if first.get("hardware_name"):
        parts.append(f"hardware {first['hardware_name']}")
    return " | ".join(parts)


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


def axis_bounds(spec: MetricSpec) -> tuple[float, float]:
    return 0, spec.y_max


def axis_ticks(spec: MetricSpec) -> list[float]:
    ticks = []
    count = int(round(spec.y_max / spec.y_interval))
    for i in range(count + 1):
        ticks.append(round(i * spec.y_interval, 10))
    return ticks


def clamp_axis(value: float, lo: float, hi: float) -> float:
    return min(max(value, lo), hi)


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
        lo, hi = axis_bounds(spec)
        gx, gy, gw, gh = x + 54, y + 40, col_w - 76, row_h - 62
        poly = " ".join(f"{sx(ts, gx, gw):.1f},{sy(clamp_axis(v, lo, hi), lo, hi, gy, gh):.1f}" for ts, v in points)

        parts.append(f'<g><rect x="{x}" y="{y}" width="{col_w}" height="{row_h}" fill="#fff" stroke="#d7dde3" rx="6"/>')
        parts.append(f'<text x="{x + 14}" y="{y + 24}" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#24313f">{esc(spec.label)} ({esc(spec.unit)})</text>')
        parts.append(f'<text x="{x + col_w - 14}" y="{y + 24}" text-anchor="end" font-family="Arial,sans-serif" font-size="12" fill="#64707d">latest {esc(fmt_value(vals[-1], spec))}</text>')
        ticks = axis_ticks(spec)
        for tick in ticks:
            yy = sy(tick, lo, hi, gy, gh)
            stroke = "#e6ebef" if tick in {lo, hi} else "#f1f3f5"
            parts.append(f'<line x1="{gx}" y1="{yy:.1f}" x2="{gx + gw}" y2="{yy:.1f}" stroke="{stroke}" stroke-width="0.7"/>')
        parts.append(f'<line x1="{gx}" y1="{gy + gh}" x2="{gx + gw}" y2="{gy + gh}" stroke="#cfd6dd"/>')
        parts.append(f'<line x1="{gx}" y1="{gy}" x2="{gx}" y2="{gy + gh}" stroke="#cfd6dd"/>')
        parts.append(f'<text x="{gx - 8}" y="{gy + 4}" text-anchor="end" font-family="Arial,sans-serif" font-size="10" fill="#6b7682">{esc(fmt_value(hi, spec))}</text>')
        parts.append(f'<text x="{gx - 8}" y="{gy + gh}" text-anchor="end" font-family="Arial,sans-serif" font-size="10" fill="#6b7682">{esc(fmt_value(lo, spec))}</text>')
        parts.append(f'<polyline fill="none" stroke="{spec.color}" stroke-width="2.5" points="{poly}"/>')
        for ts, v in points:
            parts.append(f'<circle cx="{sx(ts, gx, gw):.1f}" cy="{sy(clamp_axis(v, lo, hi), lo, hi, gy, gh):.1f}" r="2.8" fill="{spec.color}"/>')
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


FONT_3X5 = {
    " ": ["000", "000", "000", "000", "000"],
    "-": ["000", "000", "111", "000", "000"],
    ".": ["000", "000", "000", "000", "010"],
    "/": ["001", "001", "010", "100", "100"],
    "%": ["101", "001", "010", "100", "101"],
    "(": ["010", "100", "100", "100", "010"],
    ")": ["010", "001", "001", "001", "010"],
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "010", "010", "010"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
    "A": ["010", "101", "111", "101", "101"],
    "B": ["110", "101", "110", "101", "110"],
    "C": ["111", "100", "100", "100", "111"],
    "D": ["110", "101", "101", "101", "110"],
    "E": ["111", "100", "110", "100", "111"],
    "F": ["111", "100", "110", "100", "100"],
    "G": ["111", "100", "101", "101", "111"],
    "H": ["101", "101", "111", "101", "101"],
    "I": ["111", "010", "010", "010", "111"],
    "J": ["001", "001", "001", "101", "111"],
    "K": ["101", "101", "110", "101", "101"],
    "L": ["100", "100", "100", "100", "111"],
    "M": ["101", "111", "111", "101", "101"],
    "N": ["101", "111", "111", "111", "101"],
    "O": ["111", "101", "101", "101", "111"],
    "P": ["111", "101", "111", "100", "100"],
    "Q": ["111", "101", "101", "111", "001"],
    "R": ["111", "101", "111", "110", "101"],
    "S": ["111", "100", "111", "001", "111"],
    "T": ["111", "010", "010", "010", "010"],
    "U": ["101", "101", "101", "101", "111"],
    "V": ["101", "101", "101", "101", "010"],
    "W": ["101", "101", "111", "111", "101"],
    "X": ["101", "101", "010", "101", "101"],
    "Y": ["101", "101", "010", "010", "010"],
    "Z": ["111", "001", "010", "100", "111"],
}


def render_png_native(series: dict[str, list[tuple[float, float]]], png: Path, title: str, subtitle: str) -> Path:
    width, height = 1200, 760
    bg = (251, 250, 247)
    pixels = bytearray(bg * width * height)
    all_ts = [ts for points in series.values() for ts, _ in points]
    min_ts, max_ts = min(all_ts), max(all_ts)

    def rgb(hex_color: str) -> tuple[int, int, int]:
        h = hex_color.lstrip("#")
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)

    def put(x: int, y: int, color: tuple[int, int, int]) -> None:
        if 0 <= x < width and 0 <= y < height:
            i = (y * width + x) * 3
            pixels[i : i + 3] = bytes(color)

    def rect(x: int, y: int, w: int, h: int, color: tuple[int, int, int], fill: bool = False) -> None:
        if fill:
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    put(xx, yy, color)
            return
        for xx in range(x, x + w):
            put(xx, y, color)
            put(xx, y + h - 1, color)
        for yy in range(y, y + h):
            put(x, yy, color)
            put(x + w - 1, yy, color)

    def line(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int], thickness: int = 1) -> None:
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx + dy
        while True:
            for ox in range(-(thickness // 2), thickness // 2 + 1):
                for oy in range(-(thickness // 2), thickness // 2 + 1):
                    put(x0 + ox, y0 + oy, color)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def dot(cx: int, cy: int, r: int, color: tuple[int, int, int]) -> None:
        for yy in range(cy - r, cy + r + 1):
            for xx in range(cx - r, cx + r + 1):
                if (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r:
                    put(xx, yy, color)

    def text(x: int, y: int, value: str, color: tuple[int, int, int], scale: int = 3) -> None:
        cx = x
        for ch in value.upper():
            glyph = FONT_3X5.get(ch, FONT_3X5[" "])
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == "1":
                        rect(cx + gx * scale, y + gy * scale, scale, scale, color, True)
            cx += 4 * scale

    def sx(ts: float, x: int, w: int) -> int:
        return int(x + ((ts - min_ts) / ((max_ts - min_ts) or 1)) * w)

    def sy(value: float, lo: float, hi: float, y: int, h: int) -> int:
        return int(y + h - ((value - lo) / ((hi - lo) or 1)) * h)

    text(70, 28, title, (31, 41, 51), 4)
    text(70, 56, subtitle[:95], (100, 112, 125), 2)

    ml, mt = 70, 86
    col_w = int((width - ml - 30 - 36) / 2)
    row_h = int((height - mt - 54 - 36) / 3)
    for idx, spec in enumerate(METRICS):
        points = series.get(spec.key, [])
        if not points:
            continue
        vals = [v for _, v in points]
        col, row = idx % 2, idx // 2
        x, y = int(ml + col * (col_w + 36)), int(mt + row * (row_h + 18))
        rect(x, y, col_w, row_h, (255, 255, 255), True)
        rect(x, y, col_w, row_h, (215, 221, 227), False)
        color = rgb(spec.color)
        text(x + 14, y + 16, f"{spec.label} {fmt_value(vals[-1], spec)}", (36, 49, 63), 2)
        gx, gy, gw, gh = x + 54, y + 44, col_w - 76, row_h - 66
        lo, hi = axis_bounds(spec)
        for tick in axis_ticks(spec):
            yy = sy(tick, lo, hi, gy, gh)
            line(gx, yy, gx + gw, yy, (241, 243, 245), 1)
        line(gx, gy + gh, gx + gw, gy + gh, (207, 214, 221), 1)
        line(gx, gy, gx, gy + gh, (207, 214, 221), 1)
        text(gx - 48, gy - 2, fmt_value(hi, spec), (107, 118, 130), 1)
        text(gx - 48, gy + gh - 4, fmt_value(lo, spec), (107, 118, 130), 1)
        xy = [(sx(ts, gx, gw), sy(clamp_axis(v, lo, hi), lo, hi, gy, gh)) for ts, v in points]
        for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
            line(x0, y0, x1, y1, color, 3)
        for px, py in xy:
            dot(px, py, 4, color)

    raw = b"".join(b"\x00" + bytes(pixels[y * width * 3 : (y + 1) * width * 3]) for y in range(height))
    png.parent.mkdir(parents=True, exist_ok=True)
    with png.open("wb") as fh:
        def chunk(kind: bytes, data: bytes) -> None:
            fh.write(len(data).to_bytes(4, "big"))
            fh.write(kind)
            fh.write(data)
            fh.write(zlib.crc32(kind + data).to_bytes(4, "big"))

        fh.write(b"\x89PNG\r\n\x1a\n")
        chunk("IHDR".encode(), width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0]))
        chunk("IDAT".encode(), zlib.compress(raw, 6))
        chunk("IEND".encode(), b"")
    return png


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", help="Prometheus base URL. Overrides openclaw.json.")
    parser.add_argument("--config", help="Path to openclaw.json. Defaults to /home/node/.openclaw/openclaw.json inside the pod, then repo fallbacks.")
    parser.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    parser.add_argument("--pod")
    parser.add_argument("--via-pod", action="store_true")
    parser.add_argument("--engine", choices=sorted(PROMQL), help="Inference engine. Defaults to prometheus.engine from config, then vllm.")
    parser.add_argument("--deployment")
    parser.add_argument("--range-minutes", type=int, default=10)
    parser.add_argument("--step", type=int, default=15)
    parser.add_argument("--timeout", type=int, default=10)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    end = int(time.time())
    start = end - args.range_minutes * 60 + args.step
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

    gpu_info: list[dict[str, str]] = []
    gpu_promql = GPU_INFO_PROMQL.get(engine)
    if gpu_promql:
        try:
            gpu_payload = (
                query_instant_via_pod(pod, args.namespace, base_url, with_deployment(gpu_promql, args.deployment))
                if args.via_pod
                else query_instant_local(base_url, with_deployment(gpu_promql, args.deployment), args.timeout)
            )
            gpu_info = extract_gpu_info(gpu_payload)
        except Exception as exc:
            gpu_info = [{"deploymentName": "", "modelName": "", "hardware_name": f"gpu_info unavailable: {exc}"}]

    if not any(collected.values()):
        raise RuntimeError("Prometheus returned no usable samples")

    out = Path(args.out).resolve()
    subtitle = f"{args.range_minutes}-minute query_range"
    if args.via_pod:
        subtitle += f" from pod {pod}"
    if args.deployment:
        subtitle += f" | deployment {args.deployment}"
    gpu_summary = metadata_summary(gpu_info)
    if gpu_summary:
        subtitle += f" | {gpu_summary}"
    subtitle += f" | {engine} | {base_url}"
    render_svg(collected, out, "PimClaw Runtime Metrics", subtitle)
    png = render_png_with_qlmanage(out)
    if not png:
        png = render_png_native(collected, Path(str(out) + ".png"), "PimClaw Runtime Metrics", subtitle)

    latest = {}
    for spec in METRICS:
        points = collected.get(spec.key) or []
        if points:
            latest[spec.key] = fmt_value(points[-1][1], spec)
    print(json.dumps({"svg": str(out), "png": str(png) if png else None, "latest": latest, "gpu_info": gpu_info}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
