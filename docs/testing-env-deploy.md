# Deploy PimClaw To The Testing OpenClaw Environment

This document records how to apply a new PimClaw build to the local testing OpenClaw instance.

## Environment

- OpenClaw container name: `openclaw-4.1`
- OpenClaw image: `alpine/openclaw:2026.4.1`
- Docker Compose file: `/Users/bati/openclaw-docker/docker-compose.yaml`
- Persistent OpenClaw config: `/Users/bati/openclaw-docker/myclaw/openclaw.json`
- PimClaw source repo: `/Users/bati/mycodes/bedi/pimclaw`
- PimClaw plugin path inside container: `/tmp/pimclaw`

## Important Notes

- This testing environment uses the stock OpenClaw image and loads PimClaw as a path-based plugin.
- Applying a new PimClaw build does not require rebuilding the OpenClaw container image.
- The plugin files copied into the container must be owned by `node` or `root`, otherwise OpenClaw may block plugin loading with a suspicious ownership warning.
- In `openclaw-4.1`, the plugin service context does not expose the agent trigger API PimClaw originally expected.
  PimClaw therefore uses a compatibility fallback: it launches the Planner through the OpenClaw CLI.
- In that fallback mode, the Planner may not receive PimClaw tools directly. To keep planning functional,
  the Planner returns structured JSON and the plugin applies the resulting plan to the task store itself.

## Dedicated Agent Workspaces

The testing environment should use dedicated workspaces for the two PimClaw agents:

- `pimclaw-head` -> `/home/node/.openclaw/workspaces/pimclaw-head`
- `pimclaw-planner` -> `/home/node/.openclaw/workspaces/pimclaw-planner`

These values are stored in `/Users/bati/openclaw-docker/myclaw/openclaw.json` under `agents.list`.
The `pimclaw-planner` entry there is only a registered agent definition. It is
not continuously active. In PimClaw, the Planner stays idle until the plugin's
`PlannerTrigger` launches an on-demand run for a validated anomaly.

## Deployment Steps

### 1. Build PimClaw locally

Run from the PimClaw repo:

```sh
cd /Users/bati/mycodes/bedi/pimclaw
npm run build
```

Optional targeted verification:

```sh
npx vitest run src/master/__tests__/anomaly-receiver.test.ts src/__tests__/e2e.test.ts
```

### 2. Confirm the agent workspace paths in the testing config

Edit `/Users/bati/openclaw-docker/myclaw/openclaw.json` so the agent entries look like this:

```json
{
  "id": "pimclaw-head",
  "name": "pimclaw-head",
  "workspace": "/home/node/.openclaw/workspaces/pimclaw-head"
}
```

```json
{
  "id": "pimclaw-planner",
  "name": "pimclaw-planner",
  "workspace": "/home/node/.openclaw/workspaces/pimclaw-planner"
}
```

### 3. Replace the PimClaw plugin files inside the container

```sh
docker exec "openclaw-4.1" sh -lc 'rm -rf /tmp/pimclaw && mkdir -p /tmp/pimclaw'
docker cp "/Users/bati/mycodes/bedi/pimclaw/." "openclaw-4.1:/tmp/pimclaw"
```

### 4. Create the dedicated workspace directories

```sh
docker exec "openclaw-4.1" sh -lc 'mkdir -p /home/node/.openclaw/workspaces/pimclaw-head /home/node/.openclaw/workspaces/pimclaw-planner'
```

### 5. Fix plugin ownership inside the container

Run this as `root` so OpenClaw does not block the plugin:

```sh
docker exec -u root "openclaw-4.1" sh -lc 'chown -R node:node /tmp/pimclaw'
```

### 6. Restart the OpenClaw container

```sh
docker restart "openclaw-4.1"
```

## Verification

### Check container health

```sh
docker ps --filter "name=openclaw-4.1"
```

### Confirm PimClaw is loaded

```sh
docker exec "openclaw-4.1" sh -lc 'openclaw plugins inspect pimclaw'
docker exec "openclaw-4.1" sh -lc 'openclaw plugins doctor'
```

Expected result:

- PimClaw status is `loaded`
- `openclaw plugins doctor` reports no plugin issues

### Confirm the dedicated workspaces are active

```sh
docker exec "openclaw-4.1" sh -lc 'openclaw agents list --json'
```

Expected values:

- `pimclaw-head.workspace = /home/node/.openclaw/workspaces/pimclaw-head`
- `pimclaw-planner.workspace = /home/node/.openclaw/workspaces/pimclaw-planner`

### Confirm overall gateway health

```sh
docker exec "openclaw-4.1" sh -lc 'openclaw health'
```

### Confirm the OpenClaw 4.1 planner fallback is active

```sh
docker exec "openclaw-4.1" sh -lc 'grep -n "Using CLI-based planner trigger fallback" /tmp/openclaw/openclaw-$(date +%F).log'
```

Expected result:

- PimClaw logs `Using CLI-based planner trigger fallback`
- planner-triggered tasks can still move from `planning` to `ready`

## Common Failure Mode

If `openclaw plugins inspect pimclaw` reports a blocked plugin with a message like:

```text
blocked plugin candidate: suspicious ownership
```

then the copied files are not owned by `node` or `root`. Fix it with:

```sh
docker exec -u root "openclaw-4.1" sh -lc 'chown -R node:node /tmp/pimclaw'
docker restart "openclaw-4.1"
```

## Summary

Testing deployment is a plugin refresh, not an OpenClaw image rebuild:

1. Build PimClaw locally
2. Update testing config workspace paths
3. Copy PimClaw into `/tmp/pimclaw`
4. Fix ownership
5. Restart OpenClaw
6. Verify plugin load, agent workspaces, and health
