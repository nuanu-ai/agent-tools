# Nuanu Flow coding-agent plugin

Work with Nuanu Flow from a coding agent: the Flow MCP server (149 tools,
compact 2-tool surface by default), domain skills, Claude slash commands, Codex
plugin metadata, and a bundled remote-agent worker daemon.

## Install for Claude Code

**From the marketplace** (needs access to the `nuanu-ai/mgmt` repo):

```
/plugin marketplace add nuanu-ai/mgmt
/plugin install nuanu-flow@nuanu
```

**Dev mode** (from a repo checkout — no install):

```bash
claude --plugin-dir plugins/nuanu-flow
```

After editing skills/commands/config, run `/reload-plugins` (SKILL.md text
hot-reloads on its own). CI-style check: `claude plugin validate
plugins/nuanu-flow --strict`.

## Install for Codex

Production-only:

```bash
codex plugin marketplace add nuanu-ai/agent-tools
codex plugin add nuanu-flow@nuanu
```

Start a new Codex session after installation or upgrade.

For Nuanu Flow contributors, install production and development side by side:

```bash
npm run codex:setup
npm run codex:dev
```

Production remains `nuanu-flow@nuanu`. Local development is generated as
`nuanu-flow-dev@nuanu-dev`, uses `flow_dev` at
`http://localhost:3001/mcp`, and is labeled `Nuanu Flow [DEV]`. The two owned
profiles activate only one variant per new session:

```bash
npm run codex:prod
npm run codex:dev
npm run codex:refresh
npm run codex:update
```

`codex:dev` rebuilds and reinstalls when the source fingerprint changes.
`codex:refresh` forces that update without launching. Development preflight
fails if localhost is unavailable and never falls back to `flow.nuanu.com`.
No Nuanu CLI or global package is installed.

## Configure — three auth modes

1. **Proxy agent (default)** — zero config. The hosted MCP answers with an
   OAuth challenge; your browser opens Nuanu Flow, you log in, pick a
   workspace, approve. The agent then acts as you, attributed "via
   \<client\>" in the app. Revoke anytime from Agents → My proxy agents.
2. **Ambient agent (headless/worker)** — `NUANU_AGENT_KEY` set (worker-run
   sessions get it automatically): authenticates as the agent employee.
3. **Manual token (CI)** — `NUANU_TOKEN` (`plane_api_…` from Workspace
   Settings → API tokens).

| Env var           | Used for              | Meaning                                                                                                                                                         |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUANU_TOKEN`     | manual mode           | Personal API token (leave unset for OAuth)                                                                                                                      |
| `NUANU_AGENT_KEY` | ambient mode + worker | `nuanu_flow_…` key of a remote agent employee                                                                                                                   |
| `NUANU_WORKSPACE` | all (optional)        | Default workspace slug; overrides the consent choice                                                                                                            |
| `NUANU_MCP_URL`   | Claude (optional)     | Claude MCP endpoint override; Codex local development uses `NUANU_DEV_MCP_URL` through the generated plugin                                        |
| `NUANU_DEV_MCP_URL` | Codex local dev     | Local MCP endpoint override (default `http://localhost:3001/mcp`)                                                                                   |
| `NUANU_URL`       | worker + renderer     | Django API base **including `/api`**                                                                                                                            |
| `NUANU_DEV_TOKEN` | Codex local dev       | Development user token; never forwarded to production                                                                                                          |
| `NUANU_DEV_AGENT_KEY` | Codex local worker | Development worker key; mapped only inside the local worker child                                                                                               |
| `NUANU_DEV_WORKSPACE` | Codex local dev    | Development workspace slug                                                                                                                                      |

Then run `/nuanu-flow:setup` for a guided Claude Code verification. In Codex,
use the `codex-setup` skill and `npm run codex:status`. OAuth is preferred
when discovery metadata is available. `npm run codex:auth:prod` and
`npm run codex:auth:dev` handle the current environment/Keychain fallback
without writing plaintext credentials into the repository.

## What's inside

- **`skills/`** — open-standard Agent Skills: `nuanu-flow` (orientation +
  routing), `work-items`, `workspace-setup`, `project-setup`,
  `bpmn-processes`, `artifacts`, `remote-worker`, plus Codex setup and Codex
  remote-worker guidance.
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

1. In the app, create an agent employee with runtime **remote** — the create
   form shows the worker token and connect snippets up front.
2. `/nuanu-flow:launch-remote-agent nuanu_flow_…` — resolves the API URL,
   starts the worker, and prints "remote agent connected" once live.

Manual alternative: `export NUANU_URL=.../api NUANU_AGENT_KEY=nuanu_flow_...`
then `/nuanu-flow:worker` — or headless:
`node plugins/nuanu-flow/scripts/worker/worker.mjs`

For Codex workers, prefer App Server:

```bash
npm run worker:prod
# or, with NUANU_DEV_AGENT_KEY set:
npm run worker:dev
```

The wrappers select the matching Codex profile and default to
`codex-app-server`. Use `NUANU_ADAPTER=codex-exec` for simpler one-shot task
execution.

Docs: `docs/PLUGIN.md` (architecture), `docs/REMOTE_AGENTS.md` (worker
protocol spec).
