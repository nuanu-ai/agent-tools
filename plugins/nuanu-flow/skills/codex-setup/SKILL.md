---
name: codex-setup
description: Use when configuring Nuanu Flow in Codex, switching between production and localhost, diagnosing MCP authentication, refreshing local plugin changes, or updating the production plugin.
---

# Nuanu Flow Codex Setup

Use the repository scripts in the `agent-tools` checkout. They require the
existing `codex` installation and Node.js; they do not install a Nuanu CLI,
global npm package, daemon, or shell alias.

## First setup

```bash
npm run codex:setup
npm run codex:status
```

Setup keeps both identities installed in separate persistent homes:

| Mode | Plugin | MCP | Codex home |
| --- | --- | --- | --- |
| Production | `nuanu-flow@nuanu` | `flow` at `flow.nuanu.com` | `~/.codex/nuanu-flow/prod` |
| Development | `nuanu-flow-dev@nuanu-dev` | `flow_dev` at localhost | `~/.codex/nuanu-flow/dev` |

The generated development plugin is labeled `Nuanu Flow [DEV]`. Never replace
the `nuanu` marketplace with the checkout manually; setup safely migrates that
old configuration to the Git-backed production source. Each mode home links
to the base Codex `auth.json`, so the existing OpenAI login is reused without
copying credentials. Flow MCP OAuth and plugin state remain mode-local. Setup
also removes checkout-owned legacy Nuanu registrations from the base home; it
does not alter foreign marketplaces or a normal Git-backed production install.

## Start a session

```bash
npm run codex:dev
npm run codex:prod
```

Each command sets `CODEX_HOME` to the selected isolated home and starts a new
Codex session with exactly one Nuanu Flow plugin. Development prints a large
`NUANU FLOW LOCAL DEVELOPMENT` banner, rebuilds changed plugin content, and
stops if localhost is unavailable. It never falls back to production.

After editing skills, metadata, MCP configuration, or worker code, start the
next development session with `npm run codex:dev`. To force a new generated
version without launching:

```bash
npm run codex:refresh
```

## Authentication

Codex login and Flow MCP authentication are separate. Prefer MCP OAuth when
the selected server exposes discovery metadata:

```bash
npm run codex:auth:prod
npm run codex:auth:dev
```

Production fallback variables are `NUANU_TOKEN`, `NUANU_AGENT_KEY`, and
`NUANU_WORKSPACE`. Development uses only `NUANU_DEV_TOKEN`,
`NUANU_DEV_AGENT_KEY`, and `NUANU_DEV_WORKSPACE`. Never reuse a production
secret against localhost or print credential values. On macOS, the auth
command can persist fallback user tokens in Keychain.

Diagnose without changing auth:

```bash
npm run codex:status
node scripts/codex/auth-doctor.mjs --mode dev
```

## Updates and workers

Production never auto-updates during launch:

```bash
npm run codex:update
```

Workers default to inline Codex App Server execution and the matching home:

```bash
npm run worker:dev
npm run worker:prod
```

Local workers require `NUANU_DEV_AGENT_KEY`; production workers require
`NUANU_AGENT_KEY`. The production wrapper is pinned to `flow.nuanu.com`; the
development wrapper accepts only localhost/loopback endpoints.

## Tools Used

Repository-local npm scripts, Codex plugin CLI, Codex MCP CLI, macOS Keychain.
