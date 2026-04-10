---
name: deploy-to-container
description: 'Build and deploy PimClaw plugin to the local openclaw-latest Docker container. Use when asked to rebuild, redeploy, deploy pimclaw, push to container, or update the plugin in Docker.'
argument-hint: 'Optional: --skip-prometheus to skip restarting fake Prometheus'
---

# Deploy PimClaw to Container

## When to Use

- After code changes that need to be tested in the container
- When asked to "rebuild", "redeploy", "deploy to container", "push to container"
- After fixing bugs or adding features that need validation in the Docker environment

## Prerequisites

- Docker is running with container `openclaw-latest`
- The project is mounted at `/tmp/pimclaw` inside the container
- Working directory is `/Users/bati/mycodes/bedi/pimclaw`

## Procedure

### Step 1: Build TypeScript

```bash
cd /Users/bati/mycodes/bedi/pimclaw && npx tsc 2>&1
```

If build fails, fix errors before proceeding. Do NOT deploy broken builds.

### Step 2: Install plugin into container

```bash
docker exec openclaw-latest sh -c 'openclaw plugins install --link /tmp/pimclaw 2>&1'
```

This links the plugin from the mounted volume. The output should confirm installation.

### Step 3: Restart the gateway

The gateway must restart to pick up plugin changes. Killing the gateway process triggers an automatic container-level restart:

```bash
docker exec openclaw-latest sh -c 'kill $(pgrep -f openclaw-gateway) 2>/dev/null; echo "Gateway restart triggered"'
```

Wait ~5 seconds for the container to come back up, then verify:

```bash
sleep 5 && docker exec openclaw-latest sh -c 'openclaw plugins list 2>&1' | grep -i pimclaw
```

If the container is not responding, wait a few more seconds and retry — the supervisor restarts the gateway automatically.

### Step 4: Restart fake Prometheus (if applicable)

If the fake Prometheus server is needed for testing:

```bash
docker exec -d openclaw-latest python3 /tmp/pimclaw/tmp/fake-prometheus.py --port 9090 --cycle-minutes 5
```

Verify it's running:

```bash
docker exec openclaw-latest sh -c 'wget -q -O- --timeout=3 "http://localhost:9090/_fake/status" 2>&1 | head -5'
```

Skip this step if `--skip-prometheus` was specified or fake Prometheus is not needed.

### Step 5: Verify deployment

Confirm the plugin is loaded and healthy:

```bash
docker exec openclaw-latest sh -c 'openclaw plugins list 2>&1' | grep -i pimclaw
```

## Important Notes

- **Do NOT use `--foreground` flag** with `openclaw plugins install`
- **PID 1** inside the container is `openclaw` (supervisor). **PID ~15** is `openclaw-gateway`. Killing the gateway triggers auto-restart — this is expected.
- After container restart, any background processes (like fake Prometheus) need to be restarted manually.
- The project volume mount is: host `/Users/bati/mycodes/bedi/pimclaw` → container `/tmp/pimclaw`

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Build fails | Fix TypeScript errors first. Check `npx tsc 2>&1` output. |
| Container not responding after gateway kill | Wait 10 seconds. The supervisor takes a moment to restart. |
| Plugin not showing in list | Re-run `openclaw plugins install --link /tmp/pimclaw` inside the container. |
| Fake Prometheus not responding | Check if it's running: `docker exec openclaw-latest sh -c 'pgrep -f fake-prometheus'` |
