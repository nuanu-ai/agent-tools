# Nuanu agent-tools

Public distribution of Nuanu's integrations for coding agents. Today that is
the **Nuanu Flow** plugin for Claude Code and Codex: MCP tools, domain skills,
and a remote agent worker runtime.

## Install (Claude Code)

```
/plugin marketplace add nuanu-ai/agent-tools
/plugin install nuanu-flow@nuanu
```

Then run `/nuanu-flow:setup` inside Claude Code to verify auth and
connectivity. No configuration is required for the default browser-OAuth flow;
CI/scripted use can set `NUANU_TOKEN`, and remote agent workers set
`NUANU_URL` + `NUANU_AGENT_KEY` (see the plugin's README).

## Install (Codex)

For production-only use:

```bash
codex plugin marketplace add nuanu-ai/agent-tools
codex plugin add nuanu-flow@nuanu
```

Start a new Codex session after installation.

## Codex production and local development

Nuanu Flow contributors keep production and local development installed as
separate Codex plugins:

```bash
npm run codex:setup
npm run codex:dev
npm run codex:prod
npm run codex:update
```

`codex:setup` installs `nuanu-flow@nuanu` from Git and generates the isolated
`nuanu-flow-dev@nuanu-dev` plugin under `.build/`. It writes two small,
owned Codex profiles:

- `nuanu-flow-prod`: hosted `flow.nuanu.com` only.
- `nuanu-flow-dev`: localhost only, displayed as `Nuanu Flow [DEV]`.

Each launch selects exactly one profile. `codex:dev` fingerprints the plugin,
rebuilds it when content changes, verifies the local MCP endpoint, prints a
large development banner, and starts a fresh Codex session. It never falls
back to production. Use `npm run codex:refresh` to force a new local version
without launching.

Authentication persists independently of a session. OAuth is preferred when
the MCP server exposes discovery metadata. Until then:

```bash
npm run codex:auth:prod
npm run codex:auth:dev
npm run codex:status
```

Production uses `NUANU_TOKEN`, `NUANU_AGENT_KEY`, and `NUANU_WORKSPACE`.
Development uses the separate `NUANU_DEV_*` variables. On macOS, the auth
command can keep fallback user tokens in Keychain using the built-in
`security` command.

No Nuanu CLI, global npm package, daemon, or shell alias is installed. All
developer commands are repository-local npm scripts and use the existing
`codex` installation.

Workers use the same mode split:

```bash
npm run worker:dev
npm run worker:prod
```

Both default to Codex App Server. Set `NUANU_DEV_AGENT_KEY` for local work or
`NUANU_AGENT_KEY` for production.

## What's inside

| Path | What |
| --- | --- |
| `plugins/nuanu-flow` | The Nuanu Flow plugin: hosted MCP server config, domain skills (work items, BPMN processes, artifacts, project setup, remote worker, orientation), Claude slash commands/output style, Codex metadata, and the zero-dependency worker daemon. |
| `.claude-plugin/marketplace.json` | The marketplace catalog (name `nuanu`). This repo owns it — edit it here. |
| `.agents/plugins/marketplace.json` | The Codex marketplace catalog (name `nuanu`) for local and remote Codex installs. |
| `scripts/codex/` | Repository-local setup, mode launch, auth, status, update, version, and worker helpers. |

## Versioning

Claude Code plugins are versioned by commit SHA. The canonical Codex plugin
uses semantic versions; bump it with `npm run plugin:version -- patch` (or
`minor`, `major`, or an exact version). Generated development versions include
a timestamp and source fingerprint and never modify the production manifest.
Content under `plugins/` is mirrored from the source monorepo by CI.
