---
name: project-setup
description: Scaffold a new Nuanu Flow project end to end — create the project, workflow states, labels, estimates, members with roles, saved views, and optional automations or team/objective links.
---

# Project setup

Call tools via `execute_tool("<name>", {...})`. Run the steps in this order —
later steps reference IDs from earlier ones.

## 1. Create the project

`create_project` with `name` and `identifier` (short, UPPERCASE, stable —
it prefixes every work item: `ENG` → `ENG-42`). Returns the project `id`;
subsequent calls can also address it by `project_identifier`.

## 2. Workflow states

Plane auto-creates a default state set (Backlog / Todo / In Progress / Done /
Cancelled). Adjust only if the team's flow differs:

- `create_state` — requires `name`, `color` (hex), `group` ∈
  `backlog | unstarted | started | completed | cancelled`.
- `update_state` / `delete_state` to reshape the defaults.
- `set_default_state` — the state new work items land in.

Keep exactly one obvious default in `unstarted` (or `backlog` for
intake-style projects).

## 3. Labels

`create_label` (`name`, `color`) per topic/area. Prefer a small, flat set —
labels are workspace-visible filters, not a taxonomy.

## 4. Estimates (optional)

`create_estimate` (e.g. name "Story points", type points) →
`create_estimate_point` per value (1, 2, 3, 5, 8…). Work items then accept
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

## Verify

`get_project` + `list_states` + `list_labels` + `list_project_members` to
confirm the scaffold before handing the project over.

## Tools Used

`create_project`, `get_project`, `update_project`, `list_projects`, `create_state`, `update_state`, `delete_state`, `set_default_state`, `list_states`, `create_label`, `update_label`, `delete_label`, `list_labels`, `create_estimate`, `create_estimate_point`, `update_estimate`, `list_estimates`, `add_project_members`, `update_project_member`, `list_workspace_members`, `list_project_members`, `create_view`, `list_views`, `add_project_to_team`, `add_project_to_objective`, `create_automation`, `toggle_automation`
