#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NAMESPACE="baota-playground"
IMAGE_REPO="10.1.112.238:8443/baota/fake-prometheus"
TAG="latest-test"
CYCLE_MINUTES="5"
DEPLOYMENT_COUNT=""
SKIP_BUILD=false
DRY_RUN=false

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --namespace <name>      Kubernetes namespace (default: baota-playground)
  --image-repo <repo>     Image repository (default: 10.1.112.238:8443/baota/fake-prometheus)
  --tag <name>            Image tag (default: latest-test)
  --cycle-minutes <num>   Runtime cycle window in minutes (default: 5)
  --deployment-count <n>  Number of fake LLM deployments returned (default: use manifest value)
  --skip-build            Skip docker build/push and deploy existing image tag
  --dry-run               Print resolved config and exit
  -h, --help              Show this help

Examples:
  $0
  $0 --tag v1
  $0 --image-repo registry.internal/team/fake-prometheus --tag 2026-04-29
  $0 --skip-build --tag latest-test
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --image-repo) IMAGE_REPO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --cycle-minutes) CYCLE_MINUTES="$2"; shift 2 ;;
    --deployment-count) DEPLOYMENT_COUNT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if ! [[ "$CYCLE_MINUTES" =~ ^[0-9]+$ ]] || [[ "$CYCLE_MINUTES" -lt 1 ]]; then
  echo "ERROR: --cycle-minutes must be a positive integer"
  exit 1
fi

if [[ -n "$DEPLOYMENT_COUNT" ]]; then
  if ! [[ "$DEPLOYMENT_COUNT" =~ ^[0-9]+$ ]] || [[ "$DEPLOYMENT_COUNT" -lt 1 ]]; then
    echo "ERROR: --deployment-count must be a positive integer"
    exit 1
  fi
fi

IMAGE="${IMAGE_REPO}:${TAG}"
MANIFEST="$REPO_ROOT/fake-promethues-server/k8s/fake-prometheus.yaml"
TMP_MANIFEST="$(mktemp)"
RESTART_FOR_SAME_TAG=false

cleanup() {
  rm -f "$TMP_MANIFEST"
}
trap cleanup EXIT

if $DRY_RUN; then
  deployments_display="$DEPLOYMENT_COUNT"
  if [[ -z "$deployments_display" ]]; then
    deployments_display="(from manifest)"
  fi
  cat <<EOF
Resolved configuration:
  namespace:      $NAMESPACE
  image:          $IMAGE
  cycle-minutes:  $CYCLE_MINUTES
  deployments:    $deployments_display
  skip-build:     $SKIP_BUILD
  manifest:       $MANIFEST
EOF
  exit 0
fi

cd "$REPO_ROOT"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "ERROR: kubectl not found"
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found"
  exit 1
fi

CURRENT_IMAGE="$(kubectl get deployment fake-prometheus -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
if [[ "$CURRENT_IMAGE" == "$IMAGE" ]]; then
  RESTART_FOR_SAME_TAG=true
fi

if ! $SKIP_BUILD; then
  echo "=== Building $IMAGE ==="
  docker build \
    --platform linux/amd64 \
    -f "$REPO_ROOT/fake-promethues-server/Dockerfile" \
    -t "$IMAGE" \
    "$REPO_ROOT/fake-promethues-server"

  echo "=== Pushing $IMAGE ==="
  docker push "$IMAGE"
else
  echo "=== Skipping build/push; deploying existing image $IMAGE ==="
fi

echo "=== Ensuring namespace $NAMESPACE exists ==="
#kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

echo "=== Rendering manifest ==="
sed "s|ghcr.io/your-org/fake-prometheus:latest|$IMAGE|g" "$MANIFEST" > "$TMP_MANIFEST"

# Force runtime window and deployment count for deterministic monitoring tests.
CYCLE_MINUTES="$CYCLE_MINUTES" DEPLOYMENT_COUNT="$DEPLOYMENT_COUNT" python3 - "$TMP_MANIFEST" <<'PY'
import os
import re
import sys

path = sys.argv[1]
cycle = os.environ["CYCLE_MINUTES"]
deployment_count = os.environ["DEPLOYMENT_COUNT"]
with open(path, "r", encoding="utf-8") as f:
    data = f.read()

data = data.replace('--cycle-minutes=5', f'--cycle-minutes={cycle}')
if deployment_count:
    data = re.sub(
      r'(name:\s*FAKE_DEPLOYMENT_COUNT\s*\n\s*value:\s*")[^"]*(")',
      rf'\g<1>{deployment_count}\2',
      data,
      count=1,
    )

with open(path, "w", encoding="utf-8") as f:
    f.write(data)
PY

echo "=== Applying manifest ==="
kubectl apply -n "$NAMESPACE" -f "$TMP_MANIFEST"

if $RESTART_FOR_SAME_TAG; then
  echo "=== Reusing image tag; forcing rollout restart ==="
  kubectl rollout restart deployment/fake-prometheus -n "$NAMESPACE"
fi

echo "=== Waiting for rollout ==="
kubectl rollout status deployment/fake-prometheus -n "$NAMESPACE" --timeout=300s

kubectl get deploy,svc,pods -n "$NAMESPACE" -l app=fake-prometheus

echo ""
echo "=== Done: $IMAGE in namespace $NAMESPACE ==="
