#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NAMESPACE="baota-playground"
REGISTRY="10.1.112.238:8443/baota/pimclaw-openclaw"
OPENCLAW_CONFIG="$REPO_ROOT/cicd/openclaw.json"

# ── Help ────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 [options] [--tag <name>]

Options:
  --tag <name>  Image tag to use (default: latest-test)
  --config <path> Path to local openclaw.json secret source
              (default: cicd/openclaw.json; ignored by git)
  --fresh       Delete PVC and start fresh (destroys all runtime state)
  --config-only Only update Secret/ConfigMap and restart (no image build)
  --skip-build  Skip Docker build/push, just redeploy current image

Defaults: build + push + redeploy with tag latest-test, preserve PVC state.
If cicd/openclaw.json is missing, copy cicd/openclaw.example.json and fill
real secrets locally before deploying. Do not commit the real config.
EOF
  exit 0
}

FRESH=false
CONFIG_ONLY=false
SKIP_BUILD=false
TAG="latest-test"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)         TAG="$2"; shift 2 ;;
    --config)      OPENCLAW_CONFIG="$2"; shift 2 ;;
    --fresh)       FRESH=true; shift ;;
    --config-only) CONFIG_ONLY=true; shift ;;
    --skip-build)  SKIP_BUILD=true; shift ;;
    --help|-h)     usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# ── ConfigMap / Secret sync ──────────────────────────────────────────────────

sync_configs() {
  echo "=== Syncing Secret (openclaw.json from ${OPENCLAW_CONFIG}) ==="
  kubectl create secret generic pimclaw-secret \
    --from-file=openclaw.json="$OPENCLAW_CONFIG" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f - -n "$NAMESPACE"
}

# ── Restart pod ──────────────────────────────────────────────────────────────

restart_pod() {
  echo "=== Restarting deployment ==="
  kubectl rollout restart deploy pimclaw -n "$NAMESPACE"
  kubectl rollout status deploy pimclaw -n "$NAMESPACE" --timeout=600s
  kubectl get pods -n "$NAMESPACE" -l app=pimclaw
}

# ── Fresh PVC ────────────────────────────────────────────────────────────────

fresh_pvc() {
  echo "=== Scaling to 0 ==="
  kubectl scale deploy pimclaw -n "$NAMESPACE" --replicas=0 2>/dev/null || true
  sleep 10
  echo "=== Deleting PVC ==="
  kubectl delete pvc pimclaw-pvc-test-1 -n "$NAMESPACE" --force --grace-period=0 2>/dev/null || true
  sleep 10
  echo "=== Recreating PVC ==="
  kubectl apply -f "$REPO_ROOT/cicd/pimclaw-pvc-test-1.yaml" -n "$NAMESPACE"
}

# ── Validate config JSON ─────────────────────────────────────────────────────

validate_json() {
  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    cat >&2 <<EOF
ERROR: Missing local OpenClaw config: $OPENCLAW_CONFIG

The real config is intentionally ignored by git to avoid leaking secrets.
Create it from the sanitized template, then fill real values locally:

  cp "$REPO_ROOT/cicd/openclaw.example.json" "$REPO_ROOT/cicd/openclaw.json"

You can also pass a different local config with:

  $0 --config /path/to/openclaw.json
EOF
    exit 1
  fi

  if [[ "$OPENCLAW_CONFIG" == *".example.json" ]]; then
    echo "ERROR: Refusing to deploy sanitized example config: $OPENCLAW_CONFIG" >&2
    echo "Copy it to a local ignored file and replace placeholders first." >&2
    exit 1
  fi

  if grep -q '\${[A-Za-z0-9_][A-Za-z0-9_]*}' "$OPENCLAW_CONFIG"; then
    echo "ERROR: Config still contains placeholder values: $OPENCLAW_CONFIG" >&2
    echo "Replace all \${...} placeholders with real local values before deploying." >&2
    exit 1
  fi

  if ! python3 -m json.tool "$OPENCLAW_CONFIG" > /dev/null 2>&1; then
    echo "ERROR: Invalid JSON: $OPENCLAW_CONFIG"
    python3 -m json.tool "$OPENCLAW_CONFIG" 2>&1 || true
    exit 1
  fi
  echo "=== Config JSON valid ==="
}

# ── Main ─────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"
validate_json

if $CONFIG_ONLY; then
  sync_configs
  restart_pod
  exit 0
fi

if $SKIP_BUILD; then
  sync_configs
  if $FRESH; then fresh_pvc; fi
  kubectl apply -f "$REPO_ROOT/cicd/pimclaw-delopyment-template-persistent.yaml" -n "$NAMESPACE"
  sleep 5
  kubectl scale deploy pimclaw -n "$NAMESPACE" --replicas=1 2>/dev/null || true
  restart_pod
  exit 0
fi

# Full build + push + deploy
IMAGE="${REGISTRY}:${TAG}"
echo "=== Building ${IMAGE} ==="
docker build --platform linux/amd64 -f "$REPO_ROOT/Dockerfile.openclaw-latest" -t "$IMAGE" "$REPO_ROOT"

echo "=== Pushing ${IMAGE} ==="
docker push "$IMAGE"

echo "=== Updating deployment template to ${TAG} ==="
sed -i '' "s|${REGISTRY}:.*|${IMAGE}|g" "$REPO_ROOT/cicd/pimclaw-delopyment-template-persistent.yaml"

sync_configs

if $FRESH; then fresh_pvc; fi

echo "=== Applying deployment ==="
kubectl apply -f "$REPO_ROOT/cicd/pimclaw-delopyment-template-persistent.yaml" -n "$NAMESPACE"
sleep 5
kubectl scale deploy pimclaw -n "$NAMESPACE" --replicas=1 2>/dev/null || true
kubectl rollout restart deploy pimclaw -n "$NAMESPACE"

echo "=== Waiting for rollout ==="
kubectl rollout status deploy pimclaw -n "$NAMESPACE" --timeout=600s
kubectl get pods -n "$NAMESPACE" -l app=pimclaw
echo ""
echo "=== Done: ${IMAGE} ==="
