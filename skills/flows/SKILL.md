---
name: flows
description: Read or edit a project's canonical board definition, natural-language guidance, and optional movement or attachment expectations. Use work-items for ordinary item changes.
---

# Project Flow definitions

Use the `nuanu-flow` calling convention and the connected catalog's current descriptors.

## Read the board

`get_project.flow` is the source of truth for every board, including Kanban. Read its
`revision`, `description`, and ordered `columns`. Each column has a stable `id`,
a resolved `state_id`, a name, description, lifecycle group, default flag, owner,
and optional `next` and `requires` lists. The lifecycle group classifies the item;
the array defines board order. Use the actual `state_id` when moving items.

Read Flow and column descriptions for purpose, handoffs, and judgment calls.
They guide your work but do not create machine-enforced gates. Do not infer
rules or destinations from names, template type, column order, or prose.
Refresh `get_project` before the first substantive project operation and at
each handoff because the saved definition may have changed. See
[`references/project-guided-work.md`](references/project-guided-work.md) for
the small composition rule used by work modes, Flow items, and Artifacts.
When the installed bundle provides the local context helper, refresh its
sanitized project snapshot after these reads as described by `codex-setup`.
The helper is a cache for context continuity, never a replacement for the
authenticated read.

## Check a move

Only explicitly configured expectations apply:

- A nonempty `next` on the **source** column lists expected destination column IDs.
- A nonempty `requires` on the **destination** column lists expected attachments.
- Missing or empty lists mean no checks for that kind of expectation.

When a move has configured expectations, use `check_flow_transition` with the
actual project, item, and destination state IDs. Proposed description or plan
fields may be included; a preview does not save them or move the item.

Read `mode`, `blocked`, `warnings`, and `missing` with `satisfy_with` remedies.
Advisory is the default: the requested move succeeds and reports unmet expectations.
Off skips checks. Enforced blocks unmet expectations. Do not change the mode to
bypass a blocked move. After an authorized move, verify the persisted item.

Supported roles are `spec`, `plan`, `commit`, and `brief`; the returned `roles`
field explains how each is satisfied. Use `artifacts` for stored evidence and
exact versions. A pasted commit URL is not a verified commit Artifact. Descriptions
and ownership do not grant access or activate agents or Processes.

## Create or edit a board

`list_flow_types` returns Kanban and Agentic starting templates. Templates are
starter content; an existing project's saved definition remains authoritative.
`create_project` accepts either a template `flow_type` or a `flow_definition`.

For an authorized board edit, read `get_project.flow`, then call
`update_project_flow` with `definition` and `expected_revision`. The definition
contains `schema_version: 1`, `type`, `version`, `name`, `description`, `mode`, and
`columns`; omit the read-only `revision`, `roles`, and compatibility `manifest`.
Preserve IDs and state IDs for existing columns; use a new stable ID and omit
state_id for a new column. Arrange the array and choose exactly one starting
column for a nonempty board. Legacy state tools also update this definition.

If another edit changed the revision, reread and reconcile the intended changes.
Do not blindly replay an old full definition with a newer revision. Removing a
column with items or Process bindings requires resolving those references first.

Former Idea boards are ordinary custom boards. Their existing columns, items,
Artifacts, and relations remain usable; there is no special promotion action.
