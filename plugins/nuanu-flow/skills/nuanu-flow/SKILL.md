---
name: nuanu-flow
description: Start here when working with Nuanu Flow (Plane-based work management platform). Explains the object model (workspaces, projects, work items, cycles, processes, artifacts, agents), how to call Flow MCP tools, required auth env vars, and which detailed skill to load for each job.
---

# Working with Nuanu Flow

Nuanu Flow is a work-management platform (a Plane fork) with an AI layer:
BPMN **processes** orchestrate humans and AI **agent employees**, **decisions**
gate approvals, and an **artifacts** registry stores versioned files. You talk
to it through the bundled `flow` MCP server.

## Calling convention (read this first)

The `flow` MCP server runs in **compact mode** by default and publishes only
two tools:

- `search_tools(query)` — keyword search over the full catalog (~149 tools);
  returns matching tools' names + schemas.
- `execute_tool(name, arguments)` — run any catalog tool by name.

**Every skill in this plugin names canonical catalog tool names** (e.g.
`create_issue`). Call them as `execute_tool("create_issue", {...})` — you do
not need `search_tools` when a skill already gives you the name and shape.
If the server was switched to full mode (`?optimize_context=full` on the URL),
the same names are directly callable as regular MCP tools.

## Auth & connection — three modes

1. **Proxy agent (default, interactive)** — no env needed. On first contact
   the hosted MCP replies with an OAuth challenge; the browser opens Nuanu
   Flow, the user logs in with their normal account, picks a workspace, and
   approves. You then act **as that user**, and your actions are attributed
   "via <client>" (junction avatar in the app). Claude Code re-auth:
   `/mcp` -> mcp -> authenticate. Codex re-auth: `codex mcp login flow`
   after confirming the server name in `codex mcp list`. If Codex reports
   `Auth Unsupported`, load `codex-setup` and use its environment/Keychain
   fallback until the hosted endpoint exposes OAuth discovery.
2. **Ambient agent (headless)** — `NUANU_AGENT_KEY` (`nuanu_flow_…`) is set;
   automatic inside worker-run task sessions. You act **as the agent
   employee** itself.
3. **Manual token (CI/scripts)** — `NUANU_TOKEN` (`plane_api_…` from
   Workspace Settings → API tokens) acts as the user without a browser.

Optional for all modes: `NUANU_WORKSPACE` (default workspace slug; overrides
the consent-time choice), `NUANU_MCP_URL` (Claude endpoint override). Run
`/nuanu-flow:setup` in Claude Code or load `codex-setup` in Codex for a guided
check.

## Object model

- **Workspace** (addressed by slug) → **Projects** (short identifier like
  `ENG`) → **Work items** ("issues", addressed `ENG-42`).
- Work items have: **states** (grouped `backlog / unstarted / started /
completed / cancelled`), **priority** (`urgent / high / medium / low /
none`), assignees, **labels**, **estimates**, sub-items (parent), relations,
  comments, attachments.
- **Cycles** = time-boxed sprints; **Modules** = feature buckets. Both contain
  work items.
- **Teams** group members and projects across the workspace. **Objectives**
  are portfolios that roll up projects. **Views** are saved filters.
  **Automations** are event → action rules.
- **Processes** = BPMN workflow templates; a **run** executes the graph step
  by step through human tasks, agent tasks, decisions, and gateways.
  **Agent employees** are configured AI agents (local runtime or remote
  workers). **Decisions** are human approve/deny/option gates inside runs.
- **Artifacts** = versioned files/documents in a registry, bound to entities
  (projects, runs, work items, …) and organized in logical folders.

## Conventions that apply everywhere

- `workspace_slug` is optional in almost every tool — it falls back to the
  server's default workspace (`NUANU_WORKSPACE`). Pass it only to cross
  workspaces.
- **Human aliases work alongside UUIDs**: `project_identifier` (`"ENG"`),
  `issue_identifier` (`"ENG-42"`), `state_name`, `assignee_emails`,
  `assignee_names`, `label_names`, `parent_ref`. Alias matching is **exact**,
  not fuzzy.
- Every `create_*` tool returns the created entity's `id` in structured
  output — chain follow-up calls on it.
- Description/content fields named `*_html` take **HTML**, not markdown
  (`<p>…</p>`, `<ul><li>…`). Markdown pasted there renders as literal text.
- Lists paginate with `cursor` + `per_page`.

## Which skill to load

| Job                                                                  | Skill            |
| -------------------------------------------------------------------- | ---------------- |
| Create/search/triage/update work items, sprints, relations, comments | `work-items`     |
| Scaffold a new project (states, labels, estimates, members, views)   | `project-setup`  |
| Author or operate a BPMN process / approval chain / automation flow  | `bpmn-processes` |
| Store, version, search, or link files and documents                  | `artifacts`      |
| Run this agent as a remote worker executing process agent-tasks      | `remote-worker`  |
| Install, verify, or locally develop the Codex plugin                 | `codex-setup`    |
| Run remote-worker tasks through Codex App Server                     | `codex-remote-worker` |

## Tools Used

`search_tools`, `execute_tool`, `list_workspaces`, `get_workspace`, `list_projects`, `search_issues`
