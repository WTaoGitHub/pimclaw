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

- Docker is running with your target container (default: `openclaw-latest`, override with `CONTAINER_NAME`)
- The project will be copied to `/tmp/pimclaw` inside the container
- Working directory is `/Users/bati/mycodes/bedi/pimclaw`


## Procedure

### Step 1: Set container name (optional)

Set the container name to use (default: `openclaw-latest`). Example:

```bash
export CONTAINER_NAME=openclaw-latest
```

### Step 2: Build TypeScript

```bash
cd /Users/bati/mycodes/bedi/pimclaw && npx tsc 2>&1
```

If build fails, fix errors before proceeding. Do NOT deploy broken builds.

### Step 3: Copy build to container

```bash
docker cp /Users/bati/mycodes/bedi/pimclaw/. $CONTAINER_NAME:/tmp/pimclaw
```

This ensures the latest build and all files are present in the container.


### Step 4: Fix file ownership in container

After copying, set correct ownership so the container trusts the plugin files:

```bash
docker exec $CONTAINER_NAME chown -R 1000:1000 /tmp/pimclaw
```

### Step 5: Install plugin inside container

```bash
docker exec $CONTAINER_NAME sh -c 'openclaw plugins install --link /tmp/pimclaw 2>&1'
```

The output should confirm installation.


### Step 6: Restart the gateway

The gateway must restart to pick up plugin changes. Killing the gateway process triggers an automatic container-level restart:

```bash
docker exec $CONTAINER_NAME sh -c 'kill $(pgrep -f openclaw-gateway) 2>/dev/null; echo "Gateway restart triggered"'
```

Wait ~5 seconds for the container to come back up, then verify:

```bash
sleep 5 && docker exec $CONTAINER_NAME sh -c 'openclaw plugins list 2>&1' | grep -i pimclaw
```

If the container is not responding, wait a few more seconds and retry — the supervisor restarts the gateway automatically.






### Step 7: Verify deployment

Confirm the plugin is loaded and healthy:

```bash
docker exec $CONTAINER_NAME sh -c 'openclaw plugins list 2>&1' | grep -i pimclaw
```

## Important Notes

- **Do NOT use `--foreground` flag** with `openclaw plugins install`
- **PID 1** inside the container is `openclaw` (supervisor). **PID ~15** is `openclaw-gateway`. Killing the gateway triggers auto-restart — this is expected.
- After container restart, any background processes (like fake Prometheus) need to be restarted manually.
- The project is copied to `/tmp/pimclaw` in the container using `docker cp`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Build fails | Fix TypeScript errors first. Check `npx tsc 2>&1` output. |
| Container not responding after gateway kill | Wait 10 seconds. The supervisor takes a moment to restart. |
| Plugin not showing in list | Re-run `docker exec $CONTAINER_NAME sh -c 'openclaw plugins install --link /tmp/pimclaw'` inside the container. |

