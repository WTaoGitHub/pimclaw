# PimClaw CI/CD Guide

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| Docker | Building custom OpenClaw images |
| kubectl | Managing K8s deployment resources |
| Access to `10.1.112.238:8443` | Internal container registry |
| Python 3.12+ | Building offline Python wheels (Perf MCP) |

## Docker Build

### Production Image

`Dockerfile.openclaw-latest` uses a multi-stage build:

1. **Builder stage** (Node `24-bookworm`):
   - Installs npm dependencies with `npm ci`
   - Compiles TypeScript with `tsc`
   - Prunes dev dependencies
   - Extracts pre-downloaded Python wheels for Perf MCP

2. **Runtime stage** (based on `alpine/openclaw:latest`):
   - Copies compiled plugin, node_modules, agent workspace files
   - Copies Perf MCP Python server script
   - Sets up agent workspaces and seed data
   - Creates Python path for offline MCP dependencies
   - Fixes ownership to `node:node`

```bash
docker build -f Dockerfile.openclaw-latest -t pimclaw-openclaw:latest .
```

### Custom Image

`Dockerfile.openclaw-custom` builds a PimClaw-bundled OpenClaw image:

```bash
docker build -f Dockerfile.openclaw-custom -t pimclaw-openclaw:2026.4.1 .
```

## K8s Deployment

### Resources

Directory `cicd/` contains:

| File | Purpose |
|------|---------|
| `deploy.sh` | Full deployment script |
| `pimclaw-delopyment-template-persistent.yaml` | K8s Deployment template with PVC |
| `pimclaw-pvc-test-1.yaml` | PVC definition |
| `pimclaw-pvc-test-2.yaml` | Alternative PVC definition |
| `openclaw.json` | Live OpenClaw config (⚠️ contains credentials) |
| `auth-profiles.json` | Auth profiles |
| `openclaw_k8s_resources/` | Additional K8s manifests |
| `wheels/` | Pre-downloaded Python wheels for offline Docker build |

### Namespace

Default namespace: `baota-playground`

### Register/Config

`10.1.112.238:8443/baota/pimclaw-openclaw`

## Deployment Script (`cicd/deploy.sh`)

`cicd/deploy.sh` orchestrates building, pushing, and deploying PimClaw to a K8s cluster.

### Usage

```bash
./cicd/deploy.sh                    # Full build + push + redeploy (tag: latest-test)
./cicd/deploy.sh --tag v1.2.3       # Build with specific tag
./cicd/deploy.sh --fresh            # Delete PVC and start fresh (destroys all runtime state)
./cicd/deploy.sh --config-only      # Only update Secret/ConfigMap and restart pod
./cicd/deploy.sh --skip-build       # Skip Docker build/push, just redeploy current image
./cicd/deploy.sh --help             # Show full usage
```

### What deploy.sh does

1. Validates `openclaw.json` is valid JSON
2. Optionally builds Docker image (`--platform linux/amd64`) and pushes to registry
3. Updates `pimclaw-delopyment-template-persistent.yaml` with the new image tag
4. Syncs OpenClaw config to K8s Secret (`pimclaw-secret`)
5. Optionally recreates PVC
6. Applies deployment template
7. Scales deployment to 1 replica
8. Restarts (rollout restart) and waits for rollout to complete

## Testing Environment Deployment

For local testing against a Docker-based OpenClaw instance:

### Environment

- OpenClaw container: `openclaw-4.1`
- Image: `alpine/openclaw:2026.4.1`
- Docker Compose: `/Users/bati/openclaw-docker/docker-compose.yaml`
- OpenClaw config: `/Users/bati/openclaw-docker/myclaw/openclaw.json`
- PimClaw plugin path inside container: `/tmp/pimclaw`

### Steps

```bash
# 1. Build PimClaw
cd /Users/bati/mycodes/bedi/pimclaw
npm run build

# 2. Replace plugin files in container
docker exec "openclaw-4.1" sh -lc 'rm -rf /tmp/pimclaw && mkdir -p /tmp/pimclaw'
docker cp "/Users/bati/mycodes/bedi/pimclaw/." "openclaw-4.1:/tmp/pimclaw"

# 3. Create agent workspace directories
docker exec "openclaw-4.1" sh -lc 'mkdir -p /home/node/.openclaw/workspaces/pimclaw-head /home/node/.openclaw/workspaces/pimclaw-planner'

# 4. Fix ownership (prevents "suspicious ownership" plugin block)
docker exec -u root "openclaw-4.1" sh -lc 'chown -R node:node /tmp/pimclaw'

# 5. Restart
docker restart "openclaw-4.1"
```

### Verification

```bash
docker exec "openclaw-4.1" sh -lc 'openclaw plugins inspect pimclaw'
docker exec "openclaw-4.1" sh -lc 'openclaw plugins doctor'
docker exec "openclaw-4.1" sh -lc 'openclaw agents list --json'
docker exec "openclaw-4.1" sh -lc 'openclaw health'
```

## Production Deployment

Two supported scenarios:

### Scenario 1: Customized OpenClaw Image (Preferred)

PimClaw is pre-integrated into a custom OpenClaw image. Uses a stable in-image plugin location (`/app/extensions/pimclaw`).

```bash
# Build PimClaw
npm install && npm run build

# Option A: Copy built repo into custom Dockerfile
# Option B: npm pack → install tarball during image build
# Option C: Publish to registry → install during image build

# Build custom image
docker build -f Dockerfile.openclaw-custom -t pimclaw-openclaw:2026.4.1 .

# Ensure agent definitions are present in OpenClaw config
```

Config fragment:

```json
{
  "plugins": {
    "entries": {
      "pimclaw": { "enabled": true }
    },
    "load": {
      "paths": ["/app/extensions/pimclaw"]
    }
  }
}
```

### Scenario 2: Install Into Existing OpenClaw Instance

PimClaw is installed after the fact into a running OpenClaw environment.

```bash
# Build and deliver
npm install && npm run build
openclaw plugins install /opt/openclaw/plugins/pimclaw

# Or from tarball
npm pack
openclaw plugins install ./pimclaw-1.0.0.tgz
```

## OpenClaw 4.1 Compatibility

OpenClaw `2026.4.1` does not expose the plugin-side planner trigger API. PimClaw supports a CLI-based fallback:

- `PlannerTrigger` launches the Planner through the OpenClaw CLI
- The Planner returns structured JSON plan output
- The plugin applies that plan directly to the task store
- Confirm fallback is active: check logs for `Using CLI-based planner trigger fallback`

## Rollback Guidance

1. Disable or remove the new PimClaw plugin source
2. Restore the previous plugin artifact or image
3. Restore the previous OpenClaw config (agent workspace settings, plugin paths)
4. Restart OpenClaw
5. Re-run plugin and health verification

## Python Wheels for Offline Build

Pre-downloaded wheels in `cicd/wheels/` enable offline Docker builds of the Perf MCP Python dependencies. These are extracted into the runtime image during the Docker build.
