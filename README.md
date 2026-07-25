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

Give Codex this single line:

```text
Read and follow https://flow.nuanu.com/install.md
```

Codex installs or updates the plugin, opens browser authentication where the
user can sign in or create an account, and continues with conversational
workspace setup. A single fresh Codex session is required after first install
so the new plugin tools can load.

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
`nuanu-flow-dev@nuanu-dev` plugin under `.build/`. It creates two private,
persistent Codex homes below the normal Codex home:

- `~/.codex/nuanu-flow/prod`: hosted `flow.nuanu.com` only.
- `~/.codex/nuanu-flow/dev`: localhost only, displayed as `Nuanu Flow [DEV]`.

Each home contains exactly one Nuanu Flow plugin and MCP server, so a new
session cannot inherit the other mode. The wrappers set `CODEX_HOME`
automatically. They reuse the existing Codex/OpenAI login through a symlink to
the base `auth.json`; Flow OAuth and MCP state stay local to each mode.

`codex:dev` fingerprints the plugin, rebuilds it when content changes, writes
the current localhost MCP settings, verifies the local endpoint, prints a
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
`NUANU_AGENT_KEY` for production. The production wrapper accepts API and
gateway overrides only on `flow.nuanu.com`; the development wrapper accepts
only localhost/loopback endpoints. Model subprocesses receive the task's
short-lived key, never the durable worker key or an interactive user token.

For the normal remote-agent flow, copy the one-line prompt generated in Nuanu
Flow and give it to Codex. It follows
`https://flow.nuanu.com/connect/remote-agent.md`, installs the plugin if
needed, exchanges the short-lived enrollment token over standard input, and
starts the App Server worker without exposing the durable credential.

Real Codex acceptance is explicit:

```bash
npm run test:acceptance:codex
npm run test:acceptance:codex:model
```

The first command installs both variants into a temporary unauthenticated
Codex home and verifies plugin/MCP isolation. The opt-in command symlinks the
existing Codex login into temporary mode homes, then exercises the local MCP,
a fresh second session, skill refresh, and a real App Server worker task. It
never copies auth files or changes the normal production/development homes.
CI runs the credential-free command against the pinned supported Codex CLI;
the model-backed command remains explicit because it uses the developer's
existing OpenAI login.

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
