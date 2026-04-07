# Deploy PimClaw To Production OpenClaw Environments

This document defines the two supported production deployment scenarios for PimClaw.

## Supported Scenarios

PimClaw must support both of these production activation paths:

1. A customized OpenClaw image that already includes PimClaw
2. An existing OpenClaw instance where PimClaw is installed afterward as a plugin

In both cases, the goal is the same:

- the PimClaw plugin is loaded by OpenClaw
- the `pimclaw-components` service starts automatically
- the PimClaw tools become available
- the two external agents use dedicated workspaces

## Common Production Requirements

Regardless of deployment style, production should use dedicated workspaces for the two PimClaw agents:

- `pimclaw-head` -> `/home/node/.openclaw/workspaces/pimclaw-head`
- `pimclaw-planner` -> `/home/node/.openclaw/workspaces/pimclaw-planner`

Recommended persistent config shape:

```json
{
  "agents": {
    "list": [
      {
        "id": "pimclaw-head",
        "name": "pimclaw-head",
        "workspace": "/home/node/.openclaw/workspaces/pimclaw-head"
      },
      {
        "id": "pimclaw-planner",
        "name": "pimclaw-planner",
        "workspace": "/home/node/.openclaw/workspaces/pimclaw-planner"
      }
    ]
  }
}
```

Create these directories before or during deployment:

```sh
mkdir -p /home/node/.openclaw/workspaces/pimclaw-head
mkdir -p /home/node/.openclaw/workspaces/pimclaw-planner
```

## Scenario 1: Customized OpenClaw Image With PimClaw Pre-Integrated

This is the preferred product deployment path when you control the OpenClaw image build.

### Outcome

Once OpenClaw is configured and started, PimClaw is already present and all PimClaw features are activated without any manual post-install plugin step.

### Recommended Image Layout

Use a stable in-image plugin location such as:

- `/app/extensions/pimclaw`

or another fixed path that is owned by the runtime user and available at container startup.

Do not rely on `/tmp/pimclaw` in production.

### Build Flow

1. Build PimClaw

```sh
npm install
npm run build
```

2. Prepare a production-ready plugin payload

This can be one of:

- the built repo copied into the image
- a packed tarball installed during image build
- a published package installed during image build

3. Build a custom OpenClaw image that includes PimClaw

This repo includes a concrete example at `Dockerfile.openclaw-custom`.

Build it with:

```sh
docker build -f Dockerfile.openclaw-custom -t pimclaw-openclaw:2026.4.1 .
```

This repo also includes a sample Compose file for running that image:

- `docs/examples/docker-compose.custom-openclaw.yml`

The Dockerfile does the following:

- builds PimClaw in a Node builder stage
- prunes dev dependencies
- copies the plugin payload into `/app/extensions/pimclaw`
- creates the dedicated agent workspaces
- fixes ownership to `node:node`

Reference shape:

```Dockerfile
FROM alpine/openclaw:2026.4.1

USER root
COPY . /app/extensions/pimclaw
RUN chown -R node:node /app/extensions/pimclaw

USER node
```

4. Ensure OpenClaw config enables PimClaw and points to the integrated plugin path

This repo includes a sample config fragment at:

- `docs/examples/openclaw.custom-image.fragment.json`

Example config fragment:

```json
{
  "plugins": {
    "entries": {
      "pimclaw": {
        "enabled": true
      }
    },
    "load": {
      "paths": [
        "/app/extensions/pimclaw"
      ]
    }
  }
}
```

The custom image bundles the plugin files, but PimClaw is only activated when the OpenClaw config for that environment includes the plugin load path and enables the `pimclaw` entry.

The sample fragment also includes the two PimClaw agent entries with dedicated workspaces and minimal tool allowlists.
The `pimclaw-planner` entry is only a registered agent definition. It is not
intended to run continuously and should only be invoked by `PlannerTrigger`.

5. Ensure agent definitions are present in OpenClaw config with dedicated workspaces

Defining `pimclaw-planner` in the OpenClaw agent list does not make it proactively
active. The Planner has no cron schedule and should not be treated as an always-on
agent. It remains idle until the PimClaw `PlannerTrigger` component asks the
OpenClaw agent runtime to spawn a one-shot planning run for a validated anomaly.

6. Start OpenClaw

At this point PimClaw should be active automatically.

### Verification

After startup, verify:

```sh
openclaw plugins inspect pimclaw
openclaw plugins doctor
openclaw agents list --json
openclaw health
```

Expected result:

- PimClaw plugin status is `loaded`
- `pimclaw-head` has its own workspace
- `pimclaw-planner` has its own workspace
- OpenClaw health is good

## Scenario 2: Install PimClaw Into An Existing OpenClaw Instance

This path is for an OpenClaw environment that is already running and needs PimClaw added later.

### Outcome

PimClaw is installed into the existing OpenClaw runtime, enabled, and then becomes active after reload or restart.

### Recommended Install Sources

Use one of these stable sources:

- a local plugin directory mounted into the host or container
- a packaged tarball created with `npm pack`
- a published npm package

For production, prefer a stable path such as:

- `/opt/openclaw/plugins/pimclaw`
- `/app/plugins/pimclaw`

Avoid `/tmp` for the final production install path.

### Install Flow

1. Build PimClaw

```sh
npm install
npm run build
```

2. Deliver PimClaw to the target OpenClaw host or container

Example options:

- copy the built repo to a stable path
- copy a tarball and install from that artifact
- install from a registry

3. Install the plugin into the existing OpenClaw instance

Examples:

Install from a local path:

```sh
openclaw plugins install /opt/openclaw/plugins/pimclaw
```

Install from a tarball:

```sh
npm pack
openclaw plugins install ./pimclaw-1.0.0.tgz
```

4. Enable PimClaw in OpenClaw config if needed

```json
{
  "plugins": {
    "entries": {
      "pimclaw": {
        "enabled": true
      }
    }
  }
}
```

5. Add or update the PimClaw agents in persistent OpenClaw config

- `pimclaw-head`
- `pimclaw-planner`

and assign the dedicated workspace paths.

6. Create the dedicated workspace directories

7. Restart or reload OpenClaw

### Verification

Run:

```sh
openclaw plugins inspect pimclaw
openclaw plugins doctor
openclaw agents list --json
openclaw health
```

Expected result:

- PimClaw plugin status is `loaded`
- plugin doctor reports no issues
- both PimClaw agents have distinct workspace paths
- health check succeeds

## Operational Recommendation

Use these two paths for different needs:

- Customized OpenClaw image:
  Best for controlled product deployments where PimClaw should be available immediately after environment startup.
- Plugin install into existing OpenClaw:
  Best for retrofitting PimClaw into an already deployed OpenClaw environment.

## Rollback Guidance

If a production rollout fails:

1. Disable or remove the new PimClaw plugin source
2. Restore the previous plugin artifact or image
3. Restore the previous OpenClaw config if agent workspace settings or plugin paths changed
4. Restart OpenClaw
5. Re-run plugin and health verification

## Summary

Production must support both activation models:

1. PimClaw pre-integrated into a custom OpenClaw image so features are active immediately after startup
2. PimClaw installed later into an existing OpenClaw instance so features become active without rebuilding the original OpenClaw deployment
