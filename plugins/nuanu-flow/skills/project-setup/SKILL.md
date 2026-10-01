---
name: project-setup
description: Scaffold a new Nuanu Flow project end to end — create the project, workflow states, labels, estimates, members with roles, saved views, and optional automations or team/objective links.
---

# Project setup

Call pure reads via `execute_read_tool("<name>", {...})` and mutations via
`execute_tool("<name>", {...})`. Run the steps in this order — later steps
reference IDs from earlier ones.

A canonical operation name in this skill is guidance, not a current descriptor.
Summary candidates are not cacheable descriptors. Before direct execution, use
a matching cached full descriptor; otherwise make one `search_tools` lookup and
refine by canonical name or request `detail: "full"` to obtain the schema and
`schemaDigest`.

## Board definition

Every project uses one canonical Flow definition. Choose a starting template
with `list_flow_types` and pass `flow_type` to `create_project`, or provide a
custom `flow_definition`. Kanban and Agentic templates use the same format.
Include natural-language Flow and column guidance where useful. Gate mode is
advisory by default; absent or empty `next` and `requires` lists mean no checks.
See `flows` for the full format and revision-safe editing.

## 1. Create the project

`create_project` with `name` and `identifier` (short, UPPERCASE, stable —
it prefixes every flow item: `ENG` → `ENG-42`). Returns the project `id`;
subsequent calls can also address it by `project_identifier`.

## 2. Board columns

Read `get_project.flow` for the saved structure. Use `update_project_flow` with
the current revision to edit its ordered columns, guidance, and expectations.
Preserve existing column and state IDs. Choose one starting column for a nonempty
board. Legacy `create_state`, `update_state`, `delete_state`, and `set_default_state`
update the same definition; they do not maintain a separate workflow.

## 3. Labels

`create_label` (`name`, `color`) per topic/area. Prefer a small, flat set —
labels are workspace-visible filters, not a taxonomy.

## 4. Estimates (optional)

`create_estimate` (e.g. name "Story points", type points) →
`create_estimate_point` per value (1, 2, 3, 5, 8…). Flow items then accept
`estimate_point` (the point's UUID).

## 5. Members

`add_project_members` with `members: [{email | name | member UUID, role}]`.
Roles: `5` guest, `15` member, `20` admin. Members must already belong to the
workspace (`list_workspace_members` to check).

## 6. Views (optional)

`create_view` — a saved filter (e.g. "My open items", "This cycle's bugs").
Use the same filter shapes as `list_issues` (see the `work-items` skill's
references).

## 7. Wire into the org (optional)

- Team ownership: `add_project_to_team`.
- Portfolio roll-up: `add_project_to_objective`.
- Event rules: `create_automation` (+ `toggle_automation` to enable) for
  things like auto-assign on create.

If the user also wants a project brief, specification, runbook, notes, or a
knowledge structure, use the `wiki` skill with this existing project's exact
scope. Its template workflow reads project context and existing knowledge,
recommends and customizes a compatible template, and initializes through MCP.
Pass the confirmed brief and saved Flow guidance; do not generate a separate
folder scaffold or another project. Knowledge-only requests go directly to
`wiki`; creating or opening a project does not itself request initialization.

## 8. Bind the Git repository (recommended)

After the user has confirmed both the workspace and project, offer to create
`.nuanu-flow.json` at the Git root. This small, commit-safe file lets future
agent sessions select the same Flow project without a network lookup:

```json
{
  "$schema": "https://flow.nuanu.com/schemas/project-context.v1.json",
  "version": 1,
  "workspace_slug": "confirmed-workspace-slug",
  "project_identifier": "CONFIRMED_PROJECT_IDENTIFIER"
}
```

Read an existing file before changing it and never overwrite a binding
silently. Store only stable routing data: no tokens, user IDs, MCP URLs,
callback URLs, or credentials.

For a monorepo, keep one root default and add the smallest confirmed path
overrides. Paths are relative to the Git root; the most specific matching
scope wins:

```json
{
  "$schema": "https://flow.nuanu.com/schemas/project-context.v1.json",
  "version": 1,
  "workspace_slug": "confirmed-workspace-slug",
  "project_identifier": "PLATFORM",
  "scopes": [
    {
      "path": "apps/web",
      "project_identifier": "WEB"
    }
  ]
}
```

Use `.nuanu-flow.local.json` only as a gitignored, partial local override when
development data genuinely differs from the shared binding. Never create it
for credentials or normal per-user preferences.

## Verify

`get_project` + `list_states` + `list_labels` + `list_project_members` to
confirm the scaffold before handing the project over. If repository binding
was accepted, parse the written JSON and confirm the exact workspace and
project values. Flow validates the binding lazily on the first real operation;
do not add a startup network call.

## Tools Used

`create_project`, `get_project`, `update_project`, `list_projects`, `create_state`, `update_state`, `delete_state`, `set_default_state`, `list_states`, `create_label`, `update_label`, `delete_label`, `list_labels`, `create_estimate`, `create_estimate_point`, `update_estimate`, `list_estimates`, `add_project_members`, `update_project_member`, `list_workspace_members`, `list_project_members`, `create_view`, `list_views`, `add_project_to_team`, `add_project_to_objective`, `create_automation`, `toggle_automation`
