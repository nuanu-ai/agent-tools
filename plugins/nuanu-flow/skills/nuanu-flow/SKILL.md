---
name: nuanu-flow
description: Start here when working with Nuanu Flow (Plane-based work management platform). Routes product questions and UI how-tos, explains the object model (workspaces, projects, Flow items, cycles, processes, artifacts, agents), and covers Flow MCP calling and authentication.
---

# Working with Nuanu Flow

Nuanu Flow is a work-management platform (a Plane fork) with an AI layer:
BPMN **processes** orchestrate humans and AI **agent employees**, **decisions**
gate approvals, and an **artifacts** registry stores versioned files. You talk
to it through the bundled `nuanu-flow` MCP server.

## Session activation

On a startup or resume turn, treat Nuanu Flow as the session's task tracker.
When onboarding status is not already established in the thread, call the
read-only `onboarding_next` tool at most once. Continue only its returned step
when incomplete. If onboarding is complete, do not interrupt unrelated work.
If the check is unavailable, continue the user's request without a retry loop.

The SessionStart hook may also provide a repository binding loaded from
`.nuanu-flow.json`. Discovery is deliberately local and bounded: it walks only
to the Git root, reads at most 4 KiB, performs no network call, and fails open.
Validate the selected workspace/project lazily on the first real Flow
operation.

## Calling convention (read this first)

The `nuanu-flow` MCP server runs in **compact mode** by default and publishes
only
two tools:

- `search_tools(query)` — keyword search over the full catalog;
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
   Flow, where the user can sign in or create an account and approve. A new
   account may authorize before it has a workspace; use `onboarding` next.
   You then act **as that user**, and your actions are attributed
   "via <client>" (junction avatar in the app). Claude Code re-auth:
   `/mcp` -> mcp -> authenticate. In the Codex desktop app or IDE extension,
   use Authenticate for `nuanu-flow`. In Codex CLI, run the selected
   environment's `codex:auth` helper, which lets Codex open and wait for
   browser OAuth.
   If Codex reports `Auth Unsupported`, load `codex-setup` and verify OAuth
   discovery before using an advanced environment/Keychain fallback.
2. **Ambient agent (headless)** — `NUANU_AGENT_KEY` (`nuanu_flow_…`) is set;
   automatic inside worker-run task sessions. You act **as the agent
   employee** itself.
3. **Manual token (CI/scripts)** — `NUANU_TOKEN` (`plane_api_…` from
   Workspace Settings → API tokens) acts as the user without a browser.

Optional for all modes: `NUANU_WORKSPACE` (default workspace slug; overrides
the consent-time choice), `NUANU_MCP_URL` (Claude endpoint override). Run
`/nuanu-flow:setup` in Claude Code or load `codex-setup` in Codex for a guided
check.

For every host, start with the universal installer prompt published in
`https://flow.nuanu.com/install.md`. In Codex App, mention the installed plugin
only after installation when the hosted guide requires a same-chat attachment
attempt. After the host has attached or resumed, prove tool attachment by
calling `onboarding_next` once before claiming setup is ready.

## Object model

- **Workspace** (addressed by slug) → **Projects** (short identifier like
  `ENG`) → **Flow items** ("issues", addressed `ENG-42`).
- Flow items have: **states** (grouped `backlog / unstarted / started /
completed / cancelled`), **priority** (`urgent / high / medium / low /
none`), assignees, **labels**, **estimates**, sub-items (parent), relations,
  comments, attachments.
- **Cycles** = time-boxed sprints; **Modules** = feature buckets. Both contain
  Flow items.
- **Teams** group members and projects across the workspace. **Objectives**
  are portfolios that roll up projects. **Views** are saved filters.
  **Automations** are event → action rules.
- **Processes** = BPMN workflow templates; a **run** executes the graph step
  by step through human tasks, agent tasks, decisions, and gateways.
  **Agent employees** are configured AI agents (local runtime or remote
  workers). **Decisions** are human approve/deny/option gates inside runs.
- **Artifacts** = versioned files/documents in a registry, bound to entities
  (projects, runs, Flow items, …) and organized in logical folders.

## Conventions that apply everywhere

- `workspace_slug` is optional in almost every tool. Resolution order is an
  explicit user/tool argument, the most specific matching repository scope,
  the root repository binding, connection default, `NUANU_WORKSPACE`, then
  the only accessible workspace. Multiple unresolved workspaces require an
  explicit choice.
- `.nuanu-flow.json` contains `version`, `workspace_slug`, a root
  `project_identifier`, and optional path `scopes`. The nearest matching scope
  wins. `.nuanu-flow.local.json` may partially override it for local
  development only and must remain gitignored. Neither file may contain
  secrets, endpoints, callback URLs, or identity data.
- Create a repository binding only after the workspace and project are
  confirmed, normally through `project-setup`. Authentication and account
  onboarding alone are not enough to choose a project.
- **Human aliases work alongside UUIDs**: `project_identifier` (`"ENG"`),
  `issue_identifier` (`"ENG-42"`), `state_name`, `assignee_emails`,
  `assignee_names`, `label_names`, `parent_ref`. Alias matching is **exact**,
  not fuzzy.
- Every scoped `create_*` tool returns the created entity's `id` in structured
  output. Account-scoped `create_workspace` returns `{workspace: {...}}`.
- Description/content fields named `*_html` take **HTML**, not markdown
  (`<p>…</p>`, `<ul><li>…`). Markdown pasted there renders as literal text.
- Lists paginate with `cursor` + `per_page`.

## Which skill to load

| Job                                                                  | Skill                 |
| -------------------------------------------------------------------- | --------------------- |
| Explain a feature, UI path, product term, or external integration    | `product-help`        |
| First workspace, new account, or zero-workspace setup                | `onboarding`          |
| Enrich an existing empty workspace with company context and goals    | `workspace-setup`     |
| Create/search/triage/update Flow items, sprints, relations, comments | `work-items`          |
| Scaffold a new project (states, labels, estimates, members, views)   | `project-setup`       |
| Author or operate a BPMN process / approval chain / automation flow  | `bpmn-processes`      |
| Store, version, search, or link files and documents                  | `artifacts`           |
| Design, create, connect, or launch a local or remote agent employee  | `create-agent`        |
| Run this agent as a remote worker executing process agent-tasks      | `remote-worker`       |
| Install, verify, or locally develop the Codex plugin                 | `codex-setup`         |
| Run remote-worker tasks through Codex App Server                     | `codex-remote-worker` |
| Run remote-worker tasks through Claude Code                          | `claude-code-remote-worker` |

For Codex remote enrollment, use the versionless instructions at
`https://flow.nuanu.com/connect/remote-agent.md`. The copied prompt contains a
short-lived `nuanu_join_…` enrollment token and installs the plugin first when
needed.

## Tools Used

`search_tools`, `execute_tool`, `list_workspaces`, `get_workspace`, `list_projects`, `search_issues`
