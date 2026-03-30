# PimClaw OpenClaw Integration Notes

This document exists to point developers and operators to the current integration path.

## Canonical Integration Guide

Use [install.md](./install.md) as the primary source for:

- local setup
- OpenClaw registration
- MCP service configuration
- verification steps
- standalone MCP usage

The earlier exploratory integration notes have been retired in favor of a single install and integration story.

## Current Integration Model

PimClaw integrates with OpenClaw as a native plugin and exposes its management capabilities through MCP.

The important boundaries are:

- PimClaw does not access PostgreSQL directly
- PimClaw does not change Kubernetes state directly
- PimClaw depends on external MCP services for domain-specific data and execution

The initial MCP service roles are:

- `perf` for historical performance data
- `mon` for runtime monitoring workflows
- `sim` for simulation workflows

## Recommended Reading Order

1. [README.md](../README.md)
2. [developer-introduction.md](./developer-introduction.md)
3. [install.md](./install.md)
4. [requirements.md](./requirements.md)

## Developer Guidance

If you are changing OpenClaw integration behavior, start with:

- `src/index.ts`
- `openclaw.plugin.json`
- `src/config.ts`

Keep the plugin entry, manifest schema, and runtime config parsing aligned.