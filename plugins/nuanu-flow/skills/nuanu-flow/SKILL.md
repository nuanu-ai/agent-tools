---
name: nuanu-flow
description: Start here when working with Nuanu Flow. Routes product questions and UI how-tos, explains the object model (workspaces, projects, Flow items, cycles, processes, artifacts, agents), and covers Flow MCP calling and authentication.
---

# Working with Nuanu Flow

Nuanu Flow is a work-management platform with an AI-native collaboration layer:
BPMN **processes** orchestrate humans and AI **agent employees**, **decisions**
gate approvals, and an **artifacts** registry stores versioned files. You talk
to it through the bundled `nuanu-flow` MCP server.

## Onboarding and repository activation

A message with a one-time connect code (`nuanu_connect_…`) is a complete,
tool-free setup: follow its shell steps and never redirect it to plugin
installation, an `@` mention or `Continue Nuanu Flow setup`.

Do not run an onboarding preflight merely because a conversation is new,
resumed, cleared, or compacted. Call the read-only `onboarding_next` tool only
when the user explicitly asks to set up or inspect onboarding, when the
installer resumes with `Continue Nuanu Flow setup`, or when a relevant Flow
operation returns the structured code `onboarding_required`. Call it at most
once for that explicit trigger, continue only its returned incomplete step,
and never retry automatically when the check is unavailable.

The SessionStart hook may also provide a repository binding loaded from
`.nuanu-flow.json`. Discovery is deliberately local and bounded: it walks only
to the Git root, reads at most 4 KiB, performs no network call, and fails open.
Validate the selected workspace/project lazily on the first real Flow
operation.

## Work-tracking mode (always applicable)

Always resolve and follow the current work-tracking mode before deciding
whether to track substantive project work. Load `work-modes` for the normative
policy; keep this router concise. Flow unavailability must never block the
user's underlying work: fail open and continue. Work-tracking modes are
distinct from environment, development, authentication, and BPMN execution
modes.

## Calling convention (read this first)

The `nuanu-flow` MCP server runs in **compact mode** by default and publishes
three tools:

- `search_tools(query)` — keyword search over the full catalog;
  returns matching tools' names + schemas.
- `execute_read_tool(name, arguments)` — run a catalog operation declared
  read-only without weakening mutation approvals.
- `execute_tool(name, arguments)` — run a catalog mutation by name.

Skills name canonical operations; their prose and examples are not current
tool descriptors. Reuse a full descriptor supplied by this connection or its
host cache only while it matches the connection and catalog revision.
Otherwise search for the specific operation and request `detail: "full"`
when the result contains only summary candidates. Use the returned schema.

Route operations declared read-only through `execute_read_tool`, including
`feed_list`, `feed_get`, `feed_digest`, and `check_flow_transition`. Use
`execute_tool` for mutations. Follow the descriptor's read-only declaration,
not just the operation's name. In full mode, use the directly attached tools.

Refresh once after `catalog_revision_mismatch` or `unknown_operation`, then
retry at most once. Validation, permission, business, and transport errors
need their own remedy; an uncertain write is not a reason to rediscover and
repeat it. Preserve the operation's retry identity and read back when possible.

For search truncation or connector/cache implementation, read
[tool discovery](references/tool-discovery.md). Ordinary operations need
only the rule above. After a mutation, verify the requested result with the
domain's read operation before reporting completion.

## Authentication methods

1. **Proxy agent (default, interactive)** — no env needed. On first contact
   the hosted MCP replies with an OAuth challenge; the browser opens Nuanu
   Flow, where the user can sign in or create an account and approve. A new
   account may authorize before it has a workspace; use `onboarding` next. You
   then act **as that user**, and your actions are attributed
   "via <client>" (junction avatar in the app). Re-auth: `/mcp` → mcp →
   authenticate.
2. **Ambient agent (headless)** — `NUANU_AGENT_KEY` (`nuanu_flow_…`) is set;
   automatic inside worker-run task sessions. You act **as the agent
   employee** itself.
3. **Manual token (CI/scripts)** — `NUANU_TOKEN` (`nuanu_api_…` from
   Workspace Settings → API tokens) acts as the user without a browser.

Optional for all methods: `NUANU_WORKSPACE` (default workspace slug; overrides
the consent-time choice), `NUANU_MCP_URL` (endpoint override). Run
`/nuanu-flow:setup` for a guided check.

## Object model

- **Workspace** (addressed by slug) → **Projects** (short identifier like
  `ENG`) → **Flow items** ("issues", addressed `ENG-42`).
- Flow items have: **states** (grouped `backlog / unstarted / started /
completed / cancelled`), **priority** (`urgent / high / medium / low /
none`), assignees, **labels**, **estimates**, sub-items (parent), relations,
  comments, attachments.
- **Cycles** = time-boxed sprints; **Modules** = feature buckets. Both contain
  flow items.
- **Teams** group members and projects across the workspace. **Objectives**
  are portfolios that roll up projects. **Views** are saved filters.
  **Automations** are event → action rules.
- **Processes** = BPMN workflow templates; a **run** executes the graph step
  by step through human tasks, agent tasks, decisions, and gateways.
  **Agent employees** are configured AI agents (local runtime or remote
  workers). **Decisions** are human approve/deny/option gates inside runs.
- **Artifacts** = versioned files/documents in a registry, bound to entities
  (projects, runs, flow items, …) and organized in logical folders.
- **Wiki** = living collaborative documentation scoped to an organization,
  workspace, team, or project. Project Wiki pages use the same Wiki entity and
  tool family. Artifacts are immutable/versioned files and run outputs; Wiki
  pages are edited in place and organized as a document tree.

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
- Every `create_*` tool returns the created entity's `id` in structured
  output — chain follow-up calls on it.
- Description/content fields named `*_html` take **HTML**, not markdown
  (`<p>…</p>`, `<ul><li>…`). Markdown pasted there renders as literal text.
- Lists paginate with `cursor` + `per_page`.

## Which skill to load

| Job                                                                                       | Skill             |
| ----------------------------------------------------------------------------------------- | ----------------- |
| Explain a feature, UI path, product term, or external integration                         | `product-help`    |
| First workspace, new account, or unfinished first-run setup                               | `onboarding`      |
| Enrich an existing workspace with company context and goals                               | `workspace-setup` |
| Create/search/triage/update flow items, sprints, relations, comments                      | `work-items`      |
| Read or edit board definitions, guidance, and optional expectations                       | `flows`           |
| Read or post Memory feed items, correct suggestions, or use a digest                      | `memory-feed`     |
| Scaffold a new project (states, labels, estimates, members, views)                        | `project-setup`   |
| Author or operate a BPMN process / approval chain / automation flow                       | `bpmn-processes`  |
| Ask a human for a small decision or a few values during execution                         | `human-input`     |
| Improve, compare, evaluate, or promote process variants                                   | `process-refine`  |
| Store, version, search, or link files and documents                                       | `artifacts`       |
| Initialize knowledge, recommend/customize templates, edit its guide, or manage Wiki pages | `wiki`            |
| Connect or verify a personal Telegram account or Telegram group                           | `telegram`        |
| Design, create, connect, or launch a local or remote agent employee                       | `create-agent`    |
| Run this agent as a remote worker executing process agent-tasks                           | `remote-worker`   |
| Ask what work-tracking mode is active                                                     | `work-modes`      |
| Switch the current conversation's work-tracking mode                                      | `work-modes`      |
| Use Manual, Balanced, or Strict by default                                                | `work-modes`      |
| Reset the current conversation's mode override                                            | `work-modes`      |

Requests such as "initialize knowledge for this project", "recommend a
knowledge structure", "use PARA", or "change how we organize knowledge"
route to `wiki`. Pass the resolved workspace/project context; knowledge setup
does not require a new project. Merely opening a project does not initialize
its knowledge. Work-tracking modes govern tracking, not template selection.

## Tools Used

`search_tools`, `execute_read_tool`, `execute_tool`, `onboarding_next`,
`list_workspaces`, `get_workspace`, `list_projects`, `search_issues`,
`feed_list`, `feed_get`, `feed_digest`, `check_flow_transition`
