---
name: codex-setup
description: Use when configuring Nuanu Flow in Codex, switching between production and localhost, diagnosing MCP authentication, refreshing local plugin changes, or updating the production plugin.
---

# Nuanu Flow Codex Setup

Use the repository scripts in the `agent-tools` checkout. They require the
existing `codex` installation and Node.js; they do not install a Nuanu CLI,
global npm package, daemon, or shell alias.

## Select the Codex surface first

This skill covers Codex CLI setup and the temporary public-CLI fallback used
by Codex App until Nuanu Flow is published in its native directory. In Codex
App, prefer the native Workspace Plugin directory and **Connect / Sign in**
action:

- never ask the user to open Terminal, run a command, or use `codex resume`
  inside Codex App;
- let the app own OAuth completion and use automatic MCP attachment when the
  host provides it;
- distinguish plugin installation, OAuth authentication, and MCP tool
  attachment; none implies either of the others;
- continue the active conversation only after a real `onboarding_next` call
  proves that `nuanu-flow` is attached;
- do not call private App Server methods or the still-unstable
  `plugin/install` API.

If the Nuanu Flow native listing is absent in the current Codex App build,
do not stop solely for that reason. When the App conversation has
agent-controlled shell access, perform the production flow in
**Terminal-first setup** below as internal agent actions against the same
Codex profile. The agent, not the user, runs the public `codex plugin` and
`codex mcp` commands. Preserve unrelated configuration and never launch a
child Codex process or `codex app`.

After OAuth, call `onboarding_next` immediately if it is available. Plugin code
has no supported access to the active host's control channel, and adding tool
descriptions to a prompt does not register their executable dispatcher.

If the current task still has its old capability set, ask once for the user to
select the installed **Nuanu Flow** plugin from the Codex App `@` mention
picker, add `Continue Nuanu Flow setup`, and send that plugin-attached message
in the same chat. Do not claim that the App shows a native **Continue** button,
and do not send or request a plain `continue`. Only when that explicit
attachment attempt fails may you offer the hosted guide's one-click
plugin-backed task fallback. The bundled `SessionStart` hook can continue
onboarding in that task but cannot add MCP tool schemas to an already-running
one. Never display a CLI resume command. If the listing is absent and the
conversation has no shell execution capability, report that specific host
limitation.

## Terminal-first setup

```bash
npm run codex:install:dev
```

Use this by default for localhost onboarding from Codex CLI. It builds and
installs `nuanu-flow-dev@nuanu-dev` into the current Codex profile, runs
`codex mcp login nuanu-flow`, and lets Codex open exactly one HTTP(S)
authorization page in the default browser. Never open that printed URL a
second time and never open a `codex://` link; that launches the desktop app.

Codex CLI loads new MCP tools only at process startup. After OAuth completes,
the installer returns a structured lifecycle result with separate
`installation`, `authentication`, and `attachment` fields. Only when it
reports `attachment: restart_required`, tell the user to exit Codex and run
the exact `codex resume <thread-id> "Continue Nuanu Flow setup"` command
printed by the installer in the same terminal. This resumes the same
conversation and starts the onboarding check without another typed message.
Do not claim `attachment: attached` until `onboarding_next` succeeds. If Codex
asks for one-time review of the bundled Nuanu Flow `SessionStart` hook, tell the
user to review and trust that exact hook. Never bypass hook trust. Do not
request a fresh terminal, create a new chat, or launch a child Codex process.

For production, register the canonical Git-backed `nuanu` marketplace, install
`nuanu-flow@nuanu` with the Codex CLI, and run
`codex mcp login nuanu-flow`. Let Codex open the authorization page once and
keep the login attached until callback completion; do not reopen the printed
fallback URL. When an agent shell yields a running process while browser
approval is pending, keep the current agent turn open and poll that same
process until the callback completes or Codex reports a real timeout. The
browser page appearing is not a reason to finish the turn or ask the user to
reply `done`. Then resume the current thread after one CLI restart with the
fixed continuation prompt.

The OAuth helper retries one transient 502/503/504/522/524 or timeout failure
once only when no authorization page has been observed. It must never retry
after a browser URL appears because that would create a duplicate consent
page.

## Isolated CLI profiles

Use this advanced path only when the user explicitly wants parallel production
and development CLI profiles:

```bash
npm run codex:setup
npm run codex:status
```

The isolated setup keeps both identities installed in separate persistent
homes:

| Mode        | Plugin                     | MCP                              | Codex home                 |
| ----------- | -------------------------- | -------------------------------- | -------------------------- |
| Production  | `nuanu-flow@nuanu`         | `nuanu-flow` at `flow.nuanu.com` | `~/.codex/nuanu-flow/prod` |
| Development | `nuanu-flow-dev@nuanu-dev` | `nuanu-flow` at localhost        | `~/.codex/nuanu-flow/dev`  |

The generated development plugin is labeled `Nuanu Flow [DEV]`. Never replace
the `nuanu` marketplace with the checkout manually; setup safely migrates that
old configuration to the Git-backed production source. Each mode home links
to the base Codex `auth.json`, so the existing OpenAI login is reused without
copying credentials. Flow MCP OAuth and plugin state remain mode-local. Setup
also removes checkout-owned legacy Nuanu registrations from the base home; it
does not alter foreign marketplaces or a normal Git-backed production install.

## Start an isolated CLI session

```bash
npm run codex:dev
npm run codex:prod
```

Each command sets `CODEX_HOME` to the selected isolated home and starts a new
Codex session with exactly one Nuanu Flow plugin. Development prints a large
`NUANU FLOW LOCAL DEVELOPMENT` banner, rebuilds changed plugin content, and
stops if localhost is unavailable. It never falls back to production.

These commands cannot replace or hot-load tools into an existing Codex chat.
Never launch them through a tool call or background process and poll the child.
Use the current-profile terminal setup above for interactive onboarding.

After editing skills, metadata, MCP configuration, or worker code, start the
next development session with `npm run codex:dev`. To force a new generated
version without launching:

```bash
npm run codex:refresh
```

For a completely fresh install test, remove current-profile and isolated Nuanu
registrations, MCP OAuth state, remembered Nuanu Flow hook trust, saved
Codex-mode fallback tokens, caches, and the generated development package:

```bash
npm run codex:remove
npm run codex:install:dev
```

The removal preserves the normal Codex home and login, unrelated hooks,
unrelated plugins, and the separate remote-worker credential.

## Authentication

Codex login and Flow MCP authentication are separate. Prefer MCP OAuth when
the selected server exposes discovery metadata. Start browser OAuth immediately
after setup and before launching the selected session:

```bash
npm run codex:auth:prod
npm run codex:auth:dev
```

For isolated CLI profiles, each command invokes
`codex mcp login nuanu-flow` in only the selected `CODEX_HOME`. The current
profile installer invokes the same OAuth command in the normal Codex home.
Codex opens the authorization URL, owns the callback and credential storage,
and prints the URL as its fallback if native browser launch fails. The wrapper
must not open the printed URL again. Keep a running login command and the
current agent turn alive until the callback resolves. Never ask the user to
copy the URL or reply `done` unless Codex explicitly reports that browser
launch failed.

The Codex desktop app and IDE extension also expose an Authenticate action,
but the Codex CLI does not expose that clickable action.

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
