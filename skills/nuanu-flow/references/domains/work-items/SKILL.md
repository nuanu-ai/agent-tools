---
name: work-items
description: Create, search, triage, and update Flow items in Nuanu Flow (issues internally) — states, priorities, assignees, labels, comments, sub-items, relations, links, attachments, cycles/modules placement, and bulk operations.
---

# Flow items (issues)

Call pure reads via `execute_read_tool("<name>", {...})` and mutations via
`execute_tool("<name>", {...})` (see the `nuanu-flow` orientation skill). Full
payload/filter reference: `references/payloads.md`.

A canonical operation name in this skill is guidance, not a current descriptor.
Summary candidates are not cacheable descriptors. Before direct execution, use
a matching cached full descriptor; otherwise make one `search_tools` lookup and
refine by canonical name or request `detail: "full"` to obtain the schema and
`schemaDigest`.

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

## Shape a useful Flow item before creating it

A title-only request is a brief, not a ready Flow item. Ask one compact,
grouped follow-up for the missing **outcome** and **definition of done**. Ask
about owner, priority, deadline, dependencies, or constraints only when they
materially affect execution. Reuse facts already in the conversation and do
not ask the user to repeat them.

Keep the result lean:

- Title: an action plus the intended outcome, not a topic.
- Description: short HTML sections for **Outcome**, **Scope**, and **Done
  when**. Add dependencies or notes only when useful; omit empty boilerplate.
- Board fields: use the project default backlog/unstarted state, set priority
  from urgency or cost of delay, assign only a known owner, and add dates only
  for real commitments.
- Size: one deliverable that can move independently through the board. Split
  multiple deliverables or work too uncertain to estimate instead of hiding an
  epic behind a small task.

If the user already supplied enough information, or explicitly asks to create
with defaults, do not add a redundant confirmation round.

## Estimate every ready item

Call `list_estimates` before creation. Use the system with `last_used: true`
(or the only system when exactly one exists), including categories or time
estimates; never replace a project's configured scale with Fibonacci. Choose
from that system's existing points and pass the selected point's UUID as
`estimate_point`.

When no estimate system exists, propose a points system named `Fibonacci` with
values `1, 2, 3, 5, 8, 13`. Creating it changes project configuration, so get
confirmation before calling `create_estimate` with `last_used: true`. Use this
lightweight guide unless the project defines its own policy:

- `1`: trivial and fully understood; `2`: small and low-risk.
- `3`: a normal bounded task; `5`: several steps or meaningful uncertainty.
- `8`: large or risky — consider splitting; `13`: split before creating unless
  the user explicitly wants one large item.

Base the estimate on scope, complexity, uncertainty, and dependencies—not
elapsed time or business priority. If two points are equally plausible, state
the recommendation in the grouped follow-up rather than silently guessing.

## Workflows

**Create**: shape the item and resolve its estimate first, then call
`create_issue` with `project_identifier`, `name`, `description_html`,
`estimate_point`, and the relevant board fields above; returns `id`. Then place
it (`add_issue_to_cycle` / `add_issue_to_module`) and/or nest it
(`parent_ref: "ENG-10"`). Finish with `get_issue` and verify the description,
state, priority, owner, dates, and estimate that were actually persisted.

**Create many**: `bulk_create_issues` with `issues: [{name, ...}, …]` (same
per-item fields/aliases as `create_issue`, max 100) — ONE call instead of N;
always prefer it when creating 2+ items. The batch is validated up front and
created atomically. Apply the same shaping and estimate policy to every item.

**Find**: `search_issues` for text search; `list_issues` with filters
(`state_group`, `priority`, `assignees`, `labels`, `cycle`, `module`, dates —
see references) for structured queries. Archived/deleted live behind
`list_archived_issues` / `list_deleted_issues`.

**Triage loop**: `list_issues {state_group: "backlog"}` → per item
`update_issue` (priority/state/assignees) or `assign_issue`. For many at once:
`bulk_update_issues`, `bulk_archive_issues`, `bulk_delete_issues`.

**Flow expectations**: read `get_project.flow` and the current and destination
column descriptions. Only a nonempty source `next` or destination `requires`
configures a check; absent or empty lists have no restrictions. Use
`check_flow_transition` when expectations are configured. Advisory warnings
allow the move; enforced mode blocks unmet expectations. Read `warnings`,
`missing`, and the returned remedies. Do not infer gates from prose, ordering,
or type, and do not override the mode to bypass a blocked move. See `flows`.

For every ordinary state move, refresh `get_issue` immediately before the
mutation and pass its current `state_id` as `expected_state_id` plus its current
`state_entry_sequence` as `expected_state_entry_sequence` to `update_issue`.
On `stale_state` or `stale_state_entry_sequence`, reread the item and reconcile
the user's intent; do not retry the old move automatically. This applies after
gate checks too, since another actor can move the item between the check and
the update.

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

**Implementation plan**: this is an optional ordered checklist stored directly
on the Flow item, not a separate Plan entity. Use `get_implementation_plan`,
`set_implementation_plan`, and `update_implementation_plan_item`. Each item is
`{id, text, checked}`; keep IDs stable and pass `[]` to clear the checklist.
A plan is valid with or without a Spec, and an ordinary Flow item needs neither.
Whether the work should produce a Spec, plan Artifact, PR, or other evidence
comes from the current project's Flow guidance and explicit gates, not from the
work mode or template name.

**Lifecycle**: `archive_issue` / `restore_issue` / `delete_issue`;
subscriptions via `subscribe_issue` / `unsubscribe_issue`.

**Showing a board**: prefer the plugin's terminal kanban over prose:
`node <plugin>/scripts/render/render.mjs board <projectId>` (requires
NUANU_URL + NUANU_TOKEN env); otherwise render a markdown table.

## Tools Used

`create_issue`, `bulk_create_issues`, `update_issue`, `delete_issue`, `get_issue`, `list_issues`, `search_issues`, `assign_issue`, `get_implementation_plan`, `set_implementation_plan`, `update_implementation_plan_item`, `bulk_update_issues`, `bulk_archive_issues`, `bulk_delete_issues`, `archive_issue`, `restore_issue`, `list_archived_issues`, `list_deleted_issues`, `get_archived_issue`, `list_sub_issues`, `get_issue_activity`, `add_issue_comment`, `get_issue_comments`, `update_issue_comment`, `delete_issue_comment`, `add_issue_reaction`, `remove_issue_reaction`, `add_comment_reaction`, `remove_comment_reaction`, `create_issue_relation`, `remove_issue_relation`, `list_issue_relations`, `create_issue_link`, `update_issue_link`, `delete_issue_link`, `list_issue_links`, `upload_small_issue_attachment`, `create_issue_attachment_upload`, `complete_issue_attachment_upload`, `list_issue_attachments`, `delete_issue_attachment`, `subscribe_issue`, `unsubscribe_issue`, `get_issue_subscription`, `add_issue_to_cycle`, `create_module`, `add_issue_to_module`, `list_cycles`, `get_cycle`, `list_modules`, `get_module`, `list_states`, `list_labels`, `list_estimates`, `create_estimate`, `list_workspace_members`, `add_issue_label`

## Active execution claims

Assignment means responsibility, not an execution lock. Before independently
executing a Flow item, use `claim_flow_item`. Existing project permissions still
apply. A persistent MCP session keeps the private attempt key, renews the
five-minute lease every minute without LLM calls, and automatically fences
generic item state writes. Stateless transports cannot own a claim.

Read `execution_claim` on item reads/lists to see the current agent, working or
waiting status, short activity and deadline. On `claim_busy`, stop and coordinate
with the holder. On `claim_lost`, stop all state/result writes, discard the old
execution, and only then acquire with `new_attempt=true`. Never bypass the claim
through another update tool. Retry a lost acquisition response without
`new_attempt` to recover the same attempt.

Use `heartbeat_flow_item_claim` to report working/waiting and a brief activity
summary; the runtime owns periodic renewal. Waiting retains the claim. Release
explicitly using `release_flow_item_claim` when finished or yielding; completion
state transitions retire it atomically. Resume released work only by acquiring
a fresh attempt with `new_attempt=true`. Session shutdown stops renewal, and
expiry allows another agent to claim without a cleanup job.

Process agent steps use the existing Process task lease; do not add a standalone
claim. A running/waiting/paused source-linked Process and a standalone claim
cannot own the same item. A human project member can use the item detail
**Take over** button to retire the displayed claim before changing its state.
Comments, planning and attachment uploads remain collaborative.

Recovery: a stopped runtime loses its claim within five minutes of its last
successful renewal. An open MCP transport alone is not activity: after the
existing `MCP_SESSION_IDLE_SECONDS` timeout (30 minutes by default) without an
explicit claim action or read/write of that item, automatic renewal stops too.
Long external work should report activity before that timeout. A human can use
**Take over** immediately if the agent is stuck, even while it is still online.
Comments, info/planning edits, assignments, and uploads stay collaborative;
the claim guards execution state/control changes, not ordinary collaboration.
