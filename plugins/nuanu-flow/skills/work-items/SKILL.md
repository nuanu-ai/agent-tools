---
name: work-items
description: Create, search, triage, and update Flow items in Nuanu Flow (issues internally) — states, priorities, assignees, labels, comments, sub-items, relations, links, attachments, cycles/modules placement, and bulk operations.
---

# Flow items (issues)

Call tools via `execute_tool("<name>", {...})` (see the `nuanu-flow`
orientation skill). Full payload/filter reference: `references/payloads.md`.

## Top gotchas (read before writing)

1. **`description_html` is HTML, not markdown.** Send `<p>…</p>`,
   `<ul><li>…</li></ul>`, `<strong>…</strong>`. Markdown renders literally.
2. **Alias fields match exactly.** `state_name: "In Progress"` fails if the
   state is called `In progress`. When unsure, list first (`list_states`,
   `list_workspace_members`, `list_labels`) and use IDs.
3. **`null` resets, `[]` clears.** `state_id: null` → project default state;
   `assignee_ids: []` → unassign everyone; `parent_id: null` → detach.
4. Cycle/module placement is a **separate call after create**
   (`add_issue_to_cycle`, `add_issue_to_module`) — not a create field.

## Addressing

- Project: `project_id` (UUID) | `project_identifier` (`"ENG"`) | `project_name`.
- Issue: `issue_id` (UUID) | `issue_identifier` (`"ENG-42"`) | `issue_ref`.

## Core fields

- `priority`: `urgent | high | medium | low | none`.
- States belong to groups `backlog | unstarted | started | completed | cancelled`;
  set via `state_id` or `state_name`.
- People: `assignee_ids` (UUIDs) or `assignee_emails` / `assignee_names`.
- Labels: `label_ids` or `label_names`. Dates: `start_date` / `target_date`
  as `YYYY-MM-DD`.

## Workflows

**Create**: `create_issue` with `project_identifier`, `name`, and any fields
above; returns `id`. Then place it (`add_issue_to_cycle` / `add_issue_to_module`)
and/or nest it (`parent_ref: "ENG-10"`).

**Create many**: `bulk_create_issues` with `issues: [{name, ...}, …]` (same
per-item fields/aliases as `create_issue`, max 100) — ONE call instead of N;
always prefer it when creating 2+ items. The batch is validated up front and
created atomically. If the project has estimates enabled, set each item's
`estimate_point` (see `list_estimates` for point UUIDs).

**Find**: `search_issues` for text search; `list_issues` with filters
(`state_group`, `priority`, `assignees`, `labels`, `cycle`, `module`, dates —
see references) for structured queries. Archived/deleted live behind
`list_archived_issues` / `list_deleted_issues`.

**Triage loop**: `list_issues {state_group: "backlog"}` → per item
`update_issue` (priority/state/assignees) or `assign_issue`. For many at once:
`bulk_update_issues`, `bulk_archive_issues`, `bulk_delete_issues`.

**Discuss**: `add_issue_comment` (`comment_html`), `get_issue_comments`,
`update_issue_comment`, reactions (`add_issue_reaction`,
`add_comment_reaction`). `get_issue_activity` shows the audit trail.

**Structure**: sub-items via `parent_id`/`parent_ref` + `list_sub_issues`;
typed relations via `create_issue_relation` with `relation_type` ∈
`blocking | blocked_by | duplicate | relates_to | start_before | start_after |
finish_before | finish_after`; external URLs via `create_issue_link`.

**Attachments**: small files → `upload_small_issue_attachment` (one call).
Large/binary → `create_issue_attachment_upload` (presigned POST) → upload
bytes → `complete_issue_attachment_upload`.

**Lifecycle**: `archive_issue` / `restore_issue` / `delete_issue`;
subscriptions via `subscribe_issue` / `unsubscribe_issue`.

**Showing a board**: prefer the plugin's terminal kanban over prose:
`node <plugin>/scripts/render/render.mjs board <projectId>` (requires
NUANU_URL + NUANU_TOKEN env); otherwise render a markdown table.

## Tools Used

`create_issue`, `bulk_create_issues`, `update_issue`, `delete_issue`, `get_issue`, `list_issues`, `search_issues`, `assign_issue`, `bulk_update_issues`, `bulk_archive_issues`, `bulk_delete_issues`, `archive_issue`, `restore_issue`, `list_archived_issues`, `list_deleted_issues`, `get_archived_issue`, `list_sub_issues`, `get_issue_activity`, `add_issue_comment`, `get_issue_comments`, `update_issue_comment`, `delete_issue_comment`, `add_issue_reaction`, `remove_issue_reaction`, `add_comment_reaction`, `remove_comment_reaction`, `create_issue_relation`, `remove_issue_relation`, `list_issue_relations`, `create_issue_link`, `update_issue_link`, `delete_issue_link`, `list_issue_links`, `upload_small_issue_attachment`, `create_issue_attachment_upload`, `complete_issue_attachment_upload`, `list_issue_attachments`, `delete_issue_attachment`, `subscribe_issue`, `unsubscribe_issue`, `get_issue_subscription`, `add_issue_to_cycle`, `add_issue_to_module`, `list_cycles`, `get_cycle`, `list_modules`, `get_module`, `list_states`, `list_labels`, `list_workspace_members`, `add_issue_label`
