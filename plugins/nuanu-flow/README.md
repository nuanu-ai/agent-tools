# Nuanu Flow coding-agent plugin

Work with Nuanu Flow from a coding agent: the Flow MCP server (149 tools,
compact 2-tool surface by default), domain skills, Claude slash commands, Codex
plugin metadata, and a bundled remote-agent worker daemon.

## Install for Claude Code

Give Claude Code the same single line used for Codex:

```text
Read and install https://flow.nuanu.com/install.md
```

Claude follows the environment-aware guide, uses its native marketplace and
MCP OAuth commands, and then activates the plugin in the current conversation
with `/reload-plugins`. The equivalent marketplace commands are:

```text
/plugin marketplace add nuanu-ai/agent-tools
/plugin install nuanu-flow@nuanu
```

For an isolated localhost package and native browser OAuth, run
`npm run claude:install:dev`. For source-only development, run
`claude --plugin-dir plugins/nuanu-flow`; after editing plugin components, use
`/reload-plugins`. Validate releases with
`claude plugin validate plugins/nuanu-flow --strict`.

For Claude, Claude.ai, Claude Desktop, and Cowork, configure the public remote
MCP endpoint as a custom connector instead. Those apps do not install this
Claude Code plugin or use `/reload-plugins`; follow
`https://flow.nuanu.com/connect/claude-app.md`.

## Install for Codex

Give Codex this single line:

```text
Read and install https://flow.nuanu.com/install.md
```

Codex handles marketplace installation in the terminal and opens only the
browser OAuth page. After authentication, restart the CLI once and run the
printed `codex resume <thread-id> "Continue Nuanu Flow setup"` command in the
same terminal only when the installer reports `reopen_required`. The prompt starts the resumed conversation's first turn, where
the `onboarding` skill continues exactly the first unmet requirement. The
bundled `SessionStart` hook keeps Nuanu Flow available as the task tracker on
future starts and resumes. Codex requires one-time review before a plugin hook
can run; review the Nuanu Flow hook when prompted and never bypass that trust
step.

Codex App prefers the native Workspace Plugin directory, Connect action, and
MCP reload lifecycle. Until the listing is published, an App task with shell
access may install from the canonical Git marketplace as an internal agent
action. It must not ask the user to open Terminal or show a CLI resume
command. After OAuth, use the App's supported MCP reload when exposed. If the
App exposes no reload action, start one new task instead of reopening the
pre-install task, which can retain its old capability snapshot. The
`SessionStart` hook continues onboarding in that new task but cannot add MCP
tools to an already-running one. Both paths avoid private App Server APIs.

## Install skills without the plugin

Install the self-contained portable fallback into any agent supported by
`skills`:

```bash
npx skills add nuanu-ai/agent-tools --skill nuanu-flow
```

It contains the Nuanu Flow router, compiled domain references, and a simplified
zero-dependency polling worker. It can enroll and execute remote jobs without
MCP, but Agent Skills cannot universally register or authenticate an MCP
server. Use the combined plugin for native OAuth, MCP tools, startup guidance,
and the full remote-worker runtime.

Install every canonical skill separately with
`npx skills add nuanu-ai/agent-tools --skill '*'`, or refresh the portable
fallback with `npx skills update nuanu-flow`.

## Bind a repository to a Flow project

After a workspace and project are confirmed, the `project-setup` skill offers
to create a commit-safe `.nuanu-flow.json` at the Git root:

```json
{
  "$schema": "https://flow.nuanu.com/schemas/project-context.v1.json",
  "version": 1,
  "workspace_slug": "nuanu",
  "project_identifier": "FLOW"
}
```

The SessionStart hook reads this file locally and adds the binding to the
agent's short startup context. It makes no startup network request, reads at
most 4 KiB, and ignores missing or invalid files. Monorepos can add `scopes`
with relative paths and project identifiers; the most specific path wins.
Use a gitignored `.nuanu-flow.local.json` only for partial local-development
overrides. Neither file may contain credentials, endpoints, or user data.

For interactive local development in the current Codex chat:

```bash
npm run codex:install:dev
```

This builds and installs the local marketplace package in the current Codex
profile and opens only the browser OAuth page. No desktop app or fresh terminal
is required; one CLI restart loads the new MCP tools into the resumed chat,
and the printed prompt-bearing resume command starts onboarding automatically.

For advanced isolated CLI testing, install production and development side by
side. Production remains `nuanu-flow@nuanu`. Local development is generated as
`nuanu-flow-dev@nuanu-dev`, uses `nuanu-flow` at
`http://localhost:3001/mcp`, and is labeled `Nuanu Flow [DEV]`. Setup keeps
the modes in separate persistent Codex homes:

- `~/.codex/nuanu-flow/prod`
- `~/.codex/nuanu-flow/dev`

The wrappers select the matching home for every new session:

```bash
npm run codex:prod
npm run codex:dev
npm run codex:refresh
npm run codex:update
npm run codex:remove
```

`codex:dev` rebuilds and reinstalls when the source fingerprint changes.
`codex:refresh` forces that update without launching. Development preflight
fails if localhost is unavailable and never falls back to `flow.nuanu.com`.
Both homes reuse the existing Codex/OpenAI login, while Flow MCP auth remains
mode-local. No Nuanu CLI or global package is installed.

`codex:remove` provides a complete, repeatable reset for install testing. It
logs out Nuanu MCP OAuth, removes Nuanu Flow plugins and marketplaces from the
normal and isolated Codex homes, removes remembered Nuanu Flow hook trust,
deletes isolated profiles, and removes the generated development package plus
saved fallback tokens. It preserves the normal Codex login, unrelated hooks,
unrelated plugins, and the separate remote-worker credential. Run
`npm run codex:install:dev` afterward for a fresh terminal install.

## Configure — three auth modes

1. **Proxy agent (default)** — zero config. The hosted MCP answers with an
   OAuth challenge; your browser opens Nuanu Flow, you log in, pick a
   workspace, approve. The agent then acts as you, attributed "via
   \<client\>" in the app. Revoke anytime from Agents → My proxy agents.
2. **Ambient agent (headless/worker)** — `NUANU_AGENT_KEY` set (worker-run
   sessions get it automatically): authenticates as the agent employee.
3. **Manual token (CI)** — `NUANU_TOKEN` (`plane_api_…` from Workspace
   Settings → API tokens).

| Env var               | Used for              | Meaning                                                                                                     |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `NUANU_TOKEN`         | manual mode           | Personal API token (leave unset for OAuth)                                                                  |
| `NUANU_AGENT_KEY`     | ambient mode + worker | `nuanu_flow_…` key of a remote agent employee                                                               |
| `NUANU_WORKSPACE`     | all (optional)        | Default workspace slug; overrides the consent choice                                                        |
| `NUANU_MCP_URL`       | Claude (optional)     | Claude MCP endpoint override; Codex local development uses `NUANU_DEV_MCP_URL` through the generated plugin |
| `NUANU_DEV_MCP_URL`   | Codex local dev       | Local MCP endpoint override (default `http://localhost:3001/mcp`)                                           |
| `NUANU_URL`           | worker + renderer     | Django API base **including `/api`**                                                                        |
| `NUANU_DEV_TOKEN`     | Codex local dev       | Development user token; never forwarded to production                                                       |
| `NUANU_DEV_AGENT_KEY` | Codex local worker    | Development worker key; mapped only inside the local worker child                                           |
| `NUANU_DEV_WORKSPACE` | Codex local dev       | Development workspace slug                                                                                  |

Then run `/nuanu-flow:setup` for a guided Claude Code verification. In Codex,
use the `codex-setup` skill and prefer current-profile terminal installation
plus browser OAuth. Never open a `codex://` link for a terminal user. The
repository's profile-specific auth scripts remain available for explicitly
requested isolated CLI profiles. Never ask the user to copy an OAuth URL or
reply `done`; environment/Keychain credentials remain advanced fallbacks.

## What's inside

- **`skills/`** — open-standard Agent Skills: `nuanu-flow` (orientation +
  routing), `onboarding`, `work-items`, `workspace-setup`, `project-setup`,
  `bpmn-processes`, `artifacts`, `remote-worker`, plus host-specific Codex and
  Claude Code remote-worker guidance.
- **standalone `skills/nuanu-flow`** — generated portable distribution with
  flattened copies of the domain references, a source-hash manifest, and
  `scripts/worker.mjs`. Generate it from the canonical plugin skills with
  `npm run sync:skills`; verify it is current with `npm run check:skills`.
- **`commands/`** — `/nuanu-flow:setup` (env + connectivity check),
  `/nuanu-flow:launch-remote-agent <token>` (zero-config: resolve URL, start
  the worker, confirm connection), `/nuanu-flow:worker` (start the
  remote-agent daemon from pre-exported env),
  `/nuanu-flow:decisions` (terminal decision inbox — resolve pending
  approvals without opening the app), `/nuanu-flow:run` (terminal diagram of
  a process run, optionally followed live).
- **`output-styles/`** — house rendering rules (status-glyph tables, run
  pipelines, deep links); auto-applies while the plugin is enabled.
- **`scripts/render/`** — zero-dependency terminal renderer:
  `render.mjs run <runId>` (unicode run diagram with live statuses),
  `watch <runId> --until done --timeout N` (append-only follow),
  `board <projectId>` (unicode kanban), `demo` (offline preview).
  Uses `NUANU_URL` + `NUANU_TOKEN`.
- **`scripts/worker/`** — the zero-dependency worker daemon (Node ≥ 20.6),
  vendored from `apps/worker`. **Canonical source is `apps/worker`** — edit
  there and re-copy; `apps/mcp`'s test suite hash-checks the two.
- **`.mcp.json`** — Claude Code MCP config.
- **`.codex-plugin/plugin.json`** — Codex plugin metadata with inline
  OAuth-first Flow MCP config, env-header fallbacks, and write-tool approval
  prompts.

## Deep links

When the MCP server is deployed with `PLANE_WEB_URL` set, tool results carry
`Web: <url>` permalinks into the app (and `web_url` in structured output).

Optional but recommended — clickable footer badges for work-item IDs
(user-level setting, plugins can't ship it; replace the workspace slug):

```json
{
  "footerLinksRegexes": [
    {
      "regex": "\\b(?<key>[A-Z][A-Z0-9]*-\\d+)\\b",
      "urlTemplate": "https://flow.nuanu.com/<your-workspace>/browse/{key}"
    }
  ]
}
```

## Run as a remote agent

1. In the app, create an agent employee with runtime **remote**.
2. Select Codex, Claude Code, or Generic agent and copy its generated one-line
   prompt. It follows `http://localhost:3000/connect/remote-agent.md` locally
   or `https://flow.nuanu.com/connect/remote-agent.md` in production, installs
   and OAuth-authenticates the native plugin when supported, exchanges the
   single-use enrollment token without exposing the durable credential, and
   starts the selected worker.

Advanced manual alternative: set `NUANU_URL` and `NUANU_AGENT_KEY`, then use
`/nuanu-flow:worker` — or headless:
`node plugins/nuanu-flow/scripts/worker/worker.mjs`

Generic agents use the portable skill instead of the full plugin:

```bash
npx skills add nuanu-ai/agent-tools --skill nuanu-flow
node "<installed-skill-root>/scripts/worker.mjs" enroll --base-url "https://flow.nuanu.com/api"
node "<installed-skill-root>/scripts/worker.mjs" run --command "<text-in/text-out command>"
```

The enrollment token is written to the first command over standard input,
never included in the command line. The portable worker stores its durable
credential privately, passes only a task-scoped key to the child command, and
omits plugin hooks, OAuth, WebSockets, and host-specific session management.

For Codex workers, prefer App Server:

```bash
npm run worker:prod
# or, with NUANU_DEV_AGENT_KEY set:
npm run worker:dev
```

The wrappers select the matching Codex home and default to
`codex-app-server` with inline task execution. Use
`NUANU_ADAPTER=codex-exec` for simpler one-shot task execution.
`worker:prod` rejects API or gateway overrides outside `flow.nuanu.com`;
`worker:dev` rejects non-local endpoints. Only each task's short-lived agent
key is exposed to the Codex subprocess.

Docs: `docs/PLUGIN.md` (architecture), `docs/REMOTE_AGENTS.md` (worker
protocol spec).
