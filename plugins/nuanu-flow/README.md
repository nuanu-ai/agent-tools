# Nuanu Flow — Claude Code plugin

Work with Nuanu Flow from a coding agent: the Flow MCP server (149 tools,
compact 2-tool surface by default), six domain skills, slash commands, and a
bundled remote-agent worker daemon.

## Install

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

## Configure — three auth modes

1. **Proxy agent (default)** — zero config. The hosted MCP answers with an
   OAuth challenge; your browser opens Nuanu Flow, you log in, pick a
   workspace, approve. The agent then acts as you, attributed "via
   \<client\>" in the app. Revoke anytime from Agents → My proxy agents.
2. **Ambient agent (headless/worker)** — `NUANU_AGENT_KEY` set (worker-run
   sessions get it automatically): authenticates as the agent employee.
3. **Manual token (CI)** — `NUANU_TOKEN` (`plane_api_…` from Workspace
   Settings → API tokens).

| Env var | Used for | Meaning |
|---|---|---|
| `NUANU_TOKEN` | manual mode | Personal API token (leave unset for OAuth) |
| `NUANU_AGENT_KEY` | ambient mode + worker | `plane_agent_…` key of a remote agent employee |
| `NUANU_WORKSPACE` | all (optional) | Default workspace slug; overrides the consent choice |
| `NUANU_MCP_URL` | all (optional) | MCP endpoint override (default: hosted `https://flow.nuanu.com/mcp-server/mcp`; local dev: `http://localhost:3001/mcp` via `pnpm --filter @plane/mcp dev:http`) |
| `NUANU_URL` | worker + renderer | Django API base **including `/api`** |

Then run `/nuanu-flow:setup` for a guided verification.

## What's inside

- **`skills/`** — open-standard Agent Skills: `nuanu-flow` (orientation +
  routing), `work-items`, `project-setup`, `bpmn-processes`, `artifacts`,
  `remote-worker`.
- **`commands/`** — `/nuanu-flow:setup` (env + connectivity check),
  `/nuanu-flow:worker` (start the remote-agent daemon),
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
- **`.mcp.json`** — bundled `flow` MCP server (hosted HTTP, compact mode).

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

1. In the app, create an agent employee with runtime **remote** and mint a
   key (shown once).
2. `export NUANU_URL=…/api NUANU_AGENT_KEY=plane_agent_…`
3. `/nuanu-flow:worker` — or headless:
   `node plugins/nuanu-flow/scripts/worker/worker.mjs`

Docs: `docs/PLUGIN.md` (architecture), `docs/REMOTE_AGENTS.md` (worker
protocol spec).
