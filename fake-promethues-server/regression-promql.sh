#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-19099}"
CYCLE_MINUTES="${CYCLE_MINUTES:-1}"
SERVER_BIN="$SCRIPT_DIR/fake-prometheus-server"
SERVER_LOG="$SCRIPT_DIR/.regression-promql.log"

build_server() {
  (cd "$SCRIPT_DIR" && go build -o fake-prometheus-server main.go)
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

trap stop_server EXIT

build_server
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

"$SERVER_BIN" --port "$PORT" --cycle-minutes "$CYCLE_MINUTES" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
sleep 1

END=$(date +%s)
START=$((END - 300))
BASE_URL="http://127.0.0.1:$PORT/api/v1/query_range"

QPS_JSON=$(curl -fsSG "$BASE_URL" \
  --data-urlencode 'query=sum(rate(vllm:request_success_total[5m]))' \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode 'step=15')

GPU_JSON=$(curl -fsSG "$BASE_URL" \
  --data-urlencode 'query=vllm:kv_cache_usage_perc' \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode 'step=15')

TTFT_JSON=$(curl -fsSG "$BASE_URL" \
  --data-urlencode 'query=histogram_quantile(0.95, rate(vllm:time_to_first_token_seconds_bucket[5m]))' \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode 'step=15')

START="$START" END="$END" QPS_JSON="$QPS_JSON" GPU_JSON="$GPU_JSON" TTFT_JSON="$TTFT_JSON" python3 - <<'PY'
import json
import os
import sys

start = int(os.environ["START"])
end = int(os.environ["END"])

checks = [
    ("qps", json.loads(os.environ["QPS_JSON"]), True, False),
    ("gpu_utilization", json.loads(os.environ["GPU_JSON"]), False, True),
    ("ttft", json.loads(os.environ["TTFT_JSON"]), False, False),
]

for name, payload, expect_empty_metric, expect_name in checks:
    result = payload["data"]["result"]
    if not result:
        raise SystemExit(f"{name}: empty result")
    metric = result[0]["metric"]
    values = result[0]["values"]
    if not values:
        raise SystemExit(f"{name}: empty values")
    first_ts = int(float(values[0][0]))
    last_ts = int(float(values[-1][0]))
    if first_ts < start or last_ts > end:
        raise SystemExit(f"{name}: timestamps outside requested window")
    if expect_empty_metric and metric != {}:
        raise SystemExit(f"{name}: expected empty metric object, got {metric}")
    if not expect_empty_metric and metric == {}:
        raise SystemExit(f"{name}: expected labeled metric object")
    if expect_name and "__name__" not in metric:
        raise SystemExit(f"{name}: expected __name__ in metric labels")
    print(f"{name}: ok")
    print(json.dumps({"metric": metric, "values": values[:2]}, separators=(",", ":")))
PY

echo "Regression checks passed for START=$START END=$END"