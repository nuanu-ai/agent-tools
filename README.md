# Nuanu agent-tools

Public distribution of Nuanu's integrations for coding agents. Nuanu Flow is
available both as open-standard Agent Skills and as a combined Claude
Code/Codex plugin that adds the Flow MCP tools and remote-worker runtime.

## Install Agent Skills only

Install the self-contained Nuanu Flow fallback into Codex, Claude Code, or any
other agent supported by `skills`:

```bash
npx skills add nuanu-ai/agent-tools --skill nuanu-flow
```

The installed `nuanu-flow` skill includes the router, compiled domain
references, and a simplified zero-dependency remote worker. It is the
recommended fallback when the native plugin is unavailable. To install the
entire development collection as separate skills instead:

```bash
npx skills add nuanu-ai/agent-tools --skill '*'
```

Agent Skills cannot universally register or authenticate MCP servers. The
portable worker can enroll and execute remote jobs without MCP, while
interactive Flow reads and writes still require a configured MCP connection.
Prefer the combined plugin below for Codex and Claude Code because it provides
native OAuth, MCP tools, startup guidance, and the full worker runtime.

Refresh an installed fallback after this repository changes:

```bash
npx skills update nuanu-flow
```

## Install (Claude Code)

Give Claude Code the same one-line prompt used for Codex:

```text
Read and install https://flow.nuanu.com/install.md
```

Claude Code uses its native marketplace, plugin, and MCP OAuth controls. The
activation step depends on the host:

- **Claude Desktop Code tab:** install in the current session, then start one
  new Code session in the same project. The plugin's `SessionStart` hook
  continues setup on its first actual turn alongside the user's intended task,
  so there is no special continuation prompt to copy. Use
  **+ → Connectors → Nuanu Flow → Connect** in that new session if
  authentication is requested. `/reload-plugins` does not exist in this host.
- **Claude Code CLI or IDE:** run `/reload-plugins`, authenticate through
  `/mcp` if needed, and continue in the same conversation.

The direct marketplace equivalent is:

```text
/plugin marketplace add nuanu-ai/agent-tools
/plugin install nuanu-flow@nuanu
```

In CLI or IDE, use `/mcp` to authenticate if needed and
`/nuanu-flow:onboarding` to continue setup.

Claude, Claude.ai, Claude Desktop, and Cowork are a separate surface: add
Nuanu Flow as a remote MCP custom connector using
`https://flow.nuanu.com/mcp-server/mcp`. They do not install this Claude Code
plugin and do not use `/reload-plugins`. See
`https://flow.nuanu.com/connect/claude-app.md`.

For local plugin development:

```bash
npm run claude:install:dev
```

This creates `nuanu-flow-dev@nuanu-dev` with
`http://localhost:3001/mcp`, uses interactive Claude Code OAuth in CLI mode,
and keeps production and development plugin identities distinct. For the
Desktop Code host, run the installer with `--surface desktop`; it deliberately
defers native OAuth and attachment to the new Code session. Remove both Nuanu
Claude variants with `npm run claude:remove`.

## Install (Codex)

Give Codex this single line:

```text
Read and install https://flow.nuanu.com/install.md
```

Codex installs the plugin from the terminal and opens only the browser OAuth
page. Because the CLI loads new MCP tools at startup, the installer prints the
exact `codex resume <thread-id> "Continue Nuanu Flow setup"` command needed
only when its structured lifecycle result says
`attachment: restart_required`. Run it in the same terminal to continue the
same conversation and start the onboarding check immediately. Installation,
OAuth, and tool attachment are separate states; setup is complete only after
the resumed thread successfully calls `onboarding_next`. The bundled
`SessionStart` hook adds a short task-tracker reminder on future starts and
resumes, while `UserPromptSubmit` delivers remote-worker catch-up; Codex may
ask for one-time lifecycle-hook review on the first restart. The
installer never opens the desktop app, asks the user to copy an authorization
URL, bypasses hook trust, or creates a new chat.

Codex App prefers the native Workspace Plugin directory and **Connect / Sign
in** flow. Until the native listing is published, an App task with shell
access uses the same canonical Git marketplace as an internal agent action;
the user is never asked to open Terminal or run `codex resume`. After OAuth,
call `onboarding_next` immediately when it is available. If it is not, select
the installed **Nuanu Flow** plugin from the App's `@` mention picker, add
`Continue Nuanu Flow setup`, and send that plugin-attached message in the same
chat. Do not refer to a native **Continue** button or ask for a plain
`continue`. Plugin code cannot invoke the active host's control channel or
create executable tools by placing schemas in the prompt. Use the documented
one-click plugin-backed task only if the explicit same-chat attachment fails.
See `https://flow.nuanu.com/connect/codex-app.md`.

After a workspace and project are confirmed, the `project-setup` skill can
create a commit-safe `.nuanu-flow.json` at the Git root. Future sessions read
that routing context locally, without a startup network request; monorepos can
map relative path scopes to different project identifiers.

## Codex production and local development

For interactive local development in the current Codex chat:

```bash
npm run codex:install:dev
```

This builds and installs the localhost plugin into the current Codex profile,
opens only the Nuanu Flow OAuth page in the default browser, and prints the
exact prompt-bearing same-conversation resume command required after the CLI
restart. That command continues onboarding without a second typed message.

Advanced isolated CLI profiles remain available:

```bash
npm run codex:setup
npm run codex:auth:dev
npm run codex:auth:prod
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
the MCP server exposes discovery metadata:

```bash
npm run codex:auth:prod
npm run codex:auth:dev
npm run codex:status
```

Each auth command runs `codex mcp login nuanu-flow` inside only the selected
isolated profile. Codex opens the authorization URL once in the platform's
default browser, waits for the OAuth callback, and stores the credential; the
helper verifies it before returning and does not reopen the printed fallback
URL. Start `npm run codex:prod` or `npm run codex:dev` only after
authentication succeeds.

Production uses `NUANU_TOKEN`, `NUANU_AGENT_KEY`, and `NUANU_WORKSPACE`.
Development uses the separate `NUANU_DEV_*` variables. On macOS, the auth
library can keep an explicitly requested fallback user token in Keychain using
the built-in `security` command.

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
Flow and select Codex, Claude Code, or Generic agent. Every tab follows
`https://flow.nuanu.com/connect/remote-agent.md`, installs the plugin if
supported, exchanges the short-lived enrollment token over standard input,
and starts the selected worker without exposing the durable credential.

Codex workers keep a safe live feed in the background task that launched
them. The worker binds significant milestones to the inherited
`CODEX_THREAD_ID`; the plugin's `UserPromptSubmit` hook then gives only that
conversation a compact catch-up on its next user message. It reports task
start, attention, completion, failure, requeue, and connection state without
storing raw prompts, assistant deltas, tool arguments, or credentials.
Current Codex plugins cannot push a spontaneous card into an inactive chat, so
the product describes this honestly as live background output plus next-turn
catch-up.

Real Codex acceptance is explicit:

```bash
npm run test:acceptance:codex
npm run test:acceptance:codex:model
npm run test:acceptance:codex:worker
```

The first command installs both variants into a temporary unauthenticated
Codex home and verifies plugin/MCP isolation. The opt-in command symlinks the
existing Codex login into temporary mode homes, then exercises the local MCP,
a fresh second session, skill refresh, and a real App Server worker task. The
worker acceptance also verifies exact-session activity isolation, sensitive
data exclusion, one-time catch-up, and packaged-hook execution. It never
copies auth files or changes the normal production/development homes.
`test:acceptance:codex:worker` is the focused model-backed worker path for
rerunning that contract after the credential-free package acceptance has
already passed.
CI runs the credential-free command against the pinned supported Codex CLI;
the model-backed command remains explicit because it uses the developer's
existing OpenAI login.

Portable Agent Skills acceptance is also explicit:

```bash
npm run test:acceptance:skills
# opt-in: requires the local Flow API, process engine, database, and Celery
npm run test:acceptance:skills:live
```

The credential-free test performs real copied installs with the pinned
`skills` CLI for Codex, Claude Code, and Universal. The live test creates an
isolated local workspace, enrolls the installed portable worker through
standard input, completes a real process agent step, verifies revocation, and
deletes only its marker-scoped test records.

## What's inside

| Path                               | What                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/`                          | Generated open-standard Agent Skills. `skills/nuanu-flow` is a self-contained portable fallback with compiled domain references and a simplified worker; the remaining directories expose each canonical skill separately.                    |
| `plugins/nuanu-flow`               | The Nuanu Flow plugin: hosted MCP server config, domain skills (Flow items, BPMN processes, artifacts, project setup, remote worker, orientation), Claude slash commands/output style, Codex metadata, and the zero-dependency worker daemon. |
| `.claude-plugin/marketplace.json`  | The marketplace catalog (name `nuanu`). This repo owns it — edit it here.                                                                                                                                                                     |
| `.agents/plugins/marketplace.json` | The Codex marketplace catalog (name `nuanu`) for local and remote Codex installs.                                                                                                                                                             |
| `scripts/sync-skills.mjs`          | Deterministically compiles the canonical plugin skills into `skills/`, flattens portable references, copies the simplified worker, and records source hashes in a generated manifest.                                                         |
| `scripts/codex/`                   | Repository-local setup, mode launch, auth diagnostics, status, update, version, and worker helpers.                                                                                                                                           |
| `scripts/claude/`                  | Claude-native development packaging, install/OAuth, and complete Nuanu plugin cleanup.                                                                                                                                                         |

## Versioning

The canonical Claude Code and Codex manifests share one semantic version. Bump
both with `npm run plugin:version -- patch` (or `minor`, `major`, or an exact
version). Generated development versions include a timestamp and source
fingerprint and never modify either production manifest. Content under
`plugins/` is mirrored from the source monorepo by CI.
