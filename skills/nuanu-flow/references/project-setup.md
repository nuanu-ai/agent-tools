# Project setup

Call pure reads via `execute_read_tool("<name>", {...})` and mutations via
`execute_tool("<name>", {...})`. Run the steps in this order — later steps
reference IDs from earlier ones.

A canonical operation name in this skill is guidance, not a current descriptor.
Summary candidates are not cacheable descriptors. Before direct execution, use
a matching cached full descriptor; otherwise make one `search_tools` lookup and
refine by canonical name or request `detail: "full"` to obtain the schema and
`schemaDigest`.

## 1. Create the project

`create_project` with `name` and `identifier` (short, UPPERCASE, stable —
it prefixes every flow item: `ENG` → `ENG-42`). Returns the project `id`;
subsequent calls can also address it by `project_identifier`.

## 2. Workflow states

Plane auto-creates a default state set (Backlog / Todo / In Progress / Done /
Cancelled). Adjust only if the team's flow differs:

- `create_state` — requires `name`, `color` (hex), `group` ∈
  `backlog | unstarted | started | completed | cancelled`.
- `update_state` / `delete_state` to reshape the defaults.
- `set_default_state` — the state new flow items land in.

Keep exactly one obvious default in `unstarted` (or `backlog` for
intake-style projects).

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

If the user also wants a project brief, specification, runbook, or notes,
delegate that documentation to the `wiki` skill and target this project with
`project_id` or its exact `project_identifier`. Project Wiki is the same Wiki
entity and tool family, not a separate Pages product.

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
