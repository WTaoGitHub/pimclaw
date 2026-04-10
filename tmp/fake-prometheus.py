#!/usr/bin/env python3
"""
Fake Prometheus server for PimClaw Head Agent testing.

Stores accumulated time-series data in memory — like a real Prometheus.
Data is generated continuously at 15-second intervals.
The cycle pattern (3 normal + 1 anomaly) rotates every cycle_minutes (default 5).

Range queries return consistent historical data from the stored buffer,
so the Head Agent sees proper time-series trends.

Usage:
  python3 fake-prometheus.py [--port 9090] [--cycle-minutes 5]
"""

import json
import time
import random
import argparse
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# ─── Metric profiles ───────────────────────────────────────────────────────

# Each metric has [normal_1, normal_2, normal_3, anomalous] base values
METRIC_PROFILES = {
    # TTFT in seconds — anomaly: 3x spike (0.15 → 0.45)
    "ttft": {
        "bases": [0.15, 0.13, 0.16, 0.45],
        "jitter": 0.08,
        "metric_name": "sglang:time_to_first_token_seconds",
        "labels": {"model_name": "MiniMax-M2.1", "le": "0.5"},
    },
    # TPOT in seconds — anomaly: 2.5x spike
    "tpot": {
        "bases": [0.020, 0.022, 0.019, 0.055],
        "jitter": 0.05,
        "metric_name": "sglang:inter_token_latency_seconds",
        "labels": {"model_name": "MiniMax-M2.1", "le": "0.1"},
    },
    # QPS — anomaly: 50% drop
    "qps": {
        "bases": [12.0, 13.5, 11.8, 5.5],
        "jitter": 0.10,
        "metric_name": "sglang:num_requests_total",
        "labels": {"model_name": "MiniMax-M2.1"},
    },
    # Throughput tokens/sec — anomaly: 40% drop
    "throughput": {
        "bases": [480, 510, 470, 280],
        "jitter": 0.08,
        "metric_name": "sglang:generation_tokens_total",
        "labels": {"model_name": "MiniMax-M2.1"},
    },
    # GPU utilization (0-1) — anomaly: >0.95 saturation
    "gpu_utilization": {
        "bases": [0.65, 0.70, 0.62, 0.97],
        "jitter": 0.05,
        "metric_name": "sglang:token_usage",
        "labels": {"model_name": "MiniMax-M2.1"},
    },
    # Error rate — values as ratios (the PromQL does * 100 to get %)
    # Normal: ~0.5%, anomaly: ~8%
    "error_rate": {
        "bases": [0.005, 0.003, 0.008, 0.08],
        "jitter": 0.15,
        "metric_name": "sglang:num_aborted_requests_total",
        "labels": {"model_name": "MiniMax-M2.1"},
    },
}

# ─── Time-series data store ────────────────────────────────────────────────

class MetricsStore:
    """
    Stores accumulated time-series data in memory.
    Generates data points every SCRAPE_INTERVAL seconds.
    Cycle rotates every cycle_minutes: 3 normal windows + 1 anomaly window.
    """

    SCRAPE_INTERVAL = 15  # seconds between data points
    MAX_HISTORY = 3600    # keep 1 hour of history (240 data points)

    def __init__(self, cycle_minutes=5):
        self.cycle_minutes = cycle_minutes
        self.cycle_seconds = cycle_minutes * 60
        # Total cycle = 4 windows (3 normal + 1 anomaly)
        self.full_cycle_seconds = self.cycle_seconds * 4

        self.lock = threading.Lock()
        # metric_key -> list of (timestamp, value)
        self.data = {k: [] for k in METRIC_PROFILES}
        self.start_time = time.time()
        self._last_generated = self.start_time - 600  # will generate 10min of history
        self._generate_up_to(self.start_time)

    def _get_cycle_index(self, timestamp):
        """Return 0-3 based on which cycle window a timestamp falls in."""
        elapsed = timestamp - self.start_time
        position_in_full_cycle = elapsed % self.full_cycle_seconds
        window_index = int(position_in_full_cycle / self.cycle_seconds)
        return min(window_index, 3)

    def _generate_value(self, metric_key, timestamp):
        """Generate a deterministic value for a metric at a given timestamp."""
        profile = METRIC_PROFILES[metric_key]
        cycle_idx = self._get_cycle_index(timestamp)
        base = profile["bases"][cycle_idx]
        jitter_pct = profile["jitter"]
        # Use timestamp as seed for reproducibility
        seed = hash((metric_key, int(timestamp / self.SCRAPE_INTERVAL)))
        rng = random.Random(seed)
        jitter = base * jitter_pct * (rng.random() * 2 - 1)
        return base + jitter

    def _generate_up_to(self, target_time):
        """Generate all data points from _last_generated up to target_time."""
        t = self._last_generated + self.SCRAPE_INTERVAL
        # Align to scrape interval
        t = int(t / self.SCRAPE_INTERVAL) * self.SCRAPE_INTERVAL
        while t <= target_time:
            for key in METRIC_PROFILES:
                value = self._generate_value(key, t)
                self.data[key].append((float(t), value))
            t += self.SCRAPE_INTERVAL
        self._last_generated = target_time

        # Trim old data
        for key in self.data:
            if len(self.data[key]) > self.MAX_HISTORY:
                self.data[key] = self.data[key][-self.MAX_HISTORY:]

    def scrape(self):
        """Generate new data points up to current time."""
        with self.lock:
            self._generate_up_to(time.time())

    def get_instant(self, metric_key):
        """Return the latest data point for a metric."""
        self.scrape()
        with self.lock:
            points = self.data.get(metric_key, [])
            if not points:
                return None
            return points[-1]

    def get_range(self, metric_key, start, end, step):
        """Return data points within [start, end] aligned to step."""
        self.scrape()
        with self.lock:
            points = self.data.get(metric_key, [])
            if not points:
                return []

            # Index points by aligned timestamp for fast lookup
            point_map = {}
            for pt, pv in points:
                aligned = int(pt / self.SCRAPE_INTERVAL) * self.SCRAPE_INTERVAL
                point_map[aligned] = pv

            # Build result aligned to the requested step
            result = []
            t = float(int(start))
            while t <= end:
                # Find closest stored point
                closest_key = int(t / self.SCRAPE_INTERVAL) * self.SCRAPE_INTERVAL
                if closest_key in point_map:
                    result.append([t, f"{point_map[closest_key]:.6f}"])
                else:
                    # Generate a value for timestamps outside stored range
                    value = self._generate_value(metric_key, t)
                    result.append([t, f"{value:.6f}"])
                t += step
            return result

    def get_current_phase(self):
        """Return human-readable current phase."""
        idx = self._get_cycle_index(time.time())
        if idx == 3:
            return "ANOMALY"
        return f"NORMAL-{idx + 1}"

    def get_next_anomaly_in(self):
        """Seconds until next anomaly window."""
        now = time.time()
        elapsed = now - self.start_time
        position = elapsed % self.full_cycle_seconds
        anomaly_start = self.cycle_seconds * 3  # 4th window
        if position < anomaly_start:
            return anomaly_start - position
        else:
            return self.full_cycle_seconds - position + anomaly_start


# ─── PromQL query identification ───────────────────────────────────────────

def identify_metric(query):
    """Identify which PimClaw metric a PromQL query is asking for."""
    q = query.lower()
    if "time_to_first_token" in q:
        return "ttft"
    if "inter_token_latency" in q or "output_token" in q:
        return "tpot"
    # error_rate check must come before qps since both mention num_requests
    if "aborted" in q or ("error" in q and "rate" in q):
        return "error_rate"
    if "num_requests" in q:
        return "qps"
    if "generation_tokens" in q:
        return "throughput"
    if "token_usage" in q or "kv_cache" in q:
        return "gpu_utilization"
    if q.strip() == "up":
        return "_up"
    return None


# ─── HTTP Handler ───────────────────────────────────────────────────────────

store = None  # type: MetricsStore | None

class FakePrometheusHandler(BaseHTTPRequestHandler):
    """Handle Prometheus HTTP API requests."""

    def log_message(self, fmt, *args):
        phase = store.get_current_phase() if store else "?"
        print(f"[{phase}] {fmt % args}")

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/api/v1/query":
            self.handle_instant_query(params)
        elif parsed.path == "/api/v1/query_range":
            self.handle_range_query(params)
        elif parsed.path in ("/-/healthy", "/-/ready"):
            self.send_json(200, "Prometheus is Fake but Healthy")
        elif parsed.path == "/api/v1/status/config":
            self.send_json(200, {"status": "success", "data": {"yaml": "fake"}})
        elif parsed.path == "/_fake/status":
            self.handle_status()
        else:
            self.send_json(200, {
                "status": "success",
                "data": {"resultType": "vector", "result": []},
            })

    def handle_status(self):
        """Custom endpoint to check fake server state."""
        if not store:
            self.send_json(500, {"error": "store not initialized"})
            return
        now = time.time()
        info = {
            "phase": store.get_current_phase(),
            "cycle_index": store._get_cycle_index(now),
            "next_anomaly_in_seconds": round(store.get_next_anomaly_in(), 1),
            "cycle_minutes": store.cycle_minutes,
            "full_cycle_minutes": store.cycle_minutes * 4,
            "uptime_seconds": round(now - store.start_time, 1),
            "data_points_per_metric": {k: len(v) for k, v in store.data.items()},
            "metrics": list(METRIC_PROFILES.keys()),
        }
        self.send_json(200, info)

    def handle_instant_query(self, params):
        query = params.get("query", [""])[0]
        metric_key = identify_metric(query)

        if metric_key == "_up":
            self.send_json(200, {
                "status": "success",
                "data": {
                    "resultType": "vector",
                    "result": [{"metric": {"__name__": "up", "job": "sglang"}, "value": [time.time(), "1"]}],
                },
            })
            return

        if not metric_key or metric_key not in METRIC_PROFILES:
            self.send_json(200, {
                "status": "success",
                "data": {"resultType": "vector", "result": []},
            })
            return

        point = store.get_instant(metric_key)
        if not point:
            self.send_json(200, {
                "status": "success",
                "data": {"resultType": "vector", "result": []},
            })
            return

        profile = METRIC_PROFILES[metric_key]
        self.send_json(200, {
            "status": "success",
            "data": {
                "resultType": "vector",
                "result": [{
                    "metric": {"__name__": profile["metric_name"], **profile["labels"]},
                    "value": [point[0], f"{point[1]:.6f}"],
                }],
            },
        })

    def handle_range_query(self, params):
        query = params.get("query", [""])[0]
        metric_key = identify_metric(query)

        start = float(params.get("start", [time.time() - 300])[0])
        end = float(params.get("end", [time.time()])[0])
        step = int(params.get("step", [15])[0])

        if not metric_key or metric_key not in METRIC_PROFILES:
            self.send_json(200, {
                "status": "success",
                "data": {"resultType": "matrix", "result": []},
            })
            return

        values = store.get_range(metric_key, start, end, step)
        profile = METRIC_PROFILES[metric_key]

        self.send_json(200, {
            "status": "success",
            "data": {
                "resultType": "matrix",
                "result": [{
                    "metric": {"__name__": profile["metric_name"], **profile["labels"]},
                    "values": values,
                }],
            },
        })

    def send_json(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ─── Background scraper thread ─────────────────────────────────────────────

def scraper_loop():
    """Periodically generate new data points."""
    while True:
        time.sleep(MetricsStore.SCRAPE_INTERVAL)
        if store:
            store.scrape()


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    global store

    parser = argparse.ArgumentParser(description="Fake Prometheus for PimClaw testing")
    parser.add_argument("--port", type=int, default=9090, help="Listen port (default: 9090)")
    parser.add_argument("--cycle-minutes", type=int, default=5,
                        help="Minutes per cycle window (default: 5). Full cycle = 4x this (3 normal + 1 anomaly).")
    args = parser.parse_args()

    store = MetricsStore(cycle_minutes=args.cycle_minutes)

    # Start background scraper
    scraper = threading.Thread(target=scraper_loop, daemon=True)
    scraper.start()

    server = HTTPServer(("0.0.0.0", args.port), FakePrometheusHandler)

    phase = store.get_current_phase()
    next_anomaly = store.get_next_anomaly_in()
    pts = len(store.data["ttft"])

    print(f"Fake Prometheus listening on port {args.port}")
    print(f"Cycle: {args.cycle_minutes}min per window x 4 = {args.cycle_minutes * 4}min full cycle")
    print(f"Pattern: NORMAL-1 -> NORMAL-2 -> NORMAL-3 -> ANOMALY -> repeat")
    print(f"Current phase: {phase}")
    print(f"Next anomaly in: {next_anomaly:.0f}s ({next_anomaly/60:.1f}min)")
    print(f"Pre-filled: {pts} data points per metric (10 min history)")
    print(f"Anomaly: TTFT 3x, TPOT 2.5x, QPS -50%, throughput -40%, GPU >95%, errors 8%")
    print(f"Status: http://localhost:{args.port}/_fake/status")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
