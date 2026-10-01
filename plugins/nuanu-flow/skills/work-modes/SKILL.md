---
name: work-modes
description: Choose and apply Manual, Balanced, or Strict Nuanu Flow work tracking for the current conversation or account default.
metadata:
  policy_version: "2"
---

# Nuanu Flow work modes

This is the normative policy for deciding when an agent tracks work in Nuanu
Flow. Mode strictness never makes Flow availability a prerequisite for the
user's underlying work.

The mode decides **when** to create and maintain a conversation item. The
project's saved Flow decides **how** work should proceed. Balanced does not mean
spec-driven development, and no mode may infer a methodology from the template
name. Read `get_project.flow.description` and its column descriptions, then use
only the guidance and explicit gates configured for that project.

In compact MCP mode, call reads with `execute_read_tool` and mutations with
`execute_tool`. A canonical operation name is guidance, not a cached
descriptor: use a matching current descriptor or make one bounded
`search_tools` lookup before execution.

## Modes

| Mode         | Activation rule                                                                                                                                                 | Automatic Flow behavior                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Manual**   | Only when the user explicitly asks to use Flow, or the requested work directly depends on a referenced Flow item.                                               | Perform only the requested Flow operation. Do not automatically create or maintain a tracking item.                                     |
| **Balanced** | A substantive, clearly trackable goal in a resolved Flow project. Skip greetings, ordinary questions, status checks, and trivial edits or one-command requests. | Maintain one item for the conversation goal. Write at start, material scope change, blocker, and verified completion.                   |
| **Strict**   | Every substantive project goal, including implementation, research, planning, review, and debugging.                                                            | Ensure exactly one item before substantive work starts when Flow is available, then maintain the same lifecycle milestones as Balanced. |

Balanced is the recommended setup choice, but it is not an implicit default.
When no preference has been saved, resolve to Manual. Strict always requires an
explicit user choice.

Balanced and Strict both exclude greetings, ordinary questions, status checks,
trivial edits, and one-command requests. Balanced starts tracking only when the
goal is substantive, clearly trackable, and the target Flow project is
resolved. Strict uses the same trivial-work exclusions but covers every other
substantive project goal.

Manual performs the direct Flow operation the user requested or the operation
needed to answer work that directly depends on an already referenced Flow
item. Manual never turns that operation into automatic conversation tracking.

## Resolve and change the mode

Resolve in this order: current session override, persisted account default,
then Manual fallback. A session override applies only to the current
conversation. An account default applies to new conversations and any current
conversation without an override.

Natural language maps as follows:

- "Switch to Strict" sets a `session` override.
- "Use Balanced by default" sets the `default`; when a conversation reference
  is available, that same transaction clears its override so the new default
  applies immediately.
- "Reset mode" clears only the current conversation override and returns to
  the account default, or Manual fallback when no default exists.

Manual and Balanced follow the same scope rules. Every successful change takes
effect immediately from that point forward. Never backfill earlier work,
invent an earlier milestone, or reinterpret a completed operation.

Read without changing state:

```text
execute_read_tool("get_work_mode", {"conversation_ref":"nf1_<64 lowercase hex>"})
```

Set a conversation or account preference:

```text
execute_tool("set_work_mode", {
  "mode":"balanced",
  "scope":"default",
  "conversation_ref":"nf1_<64 lowercase hex>",
  "accepted_policy_version":2
})
```

Reset the conversation override:

```text
execute_tool("reset_work_mode", {
  "conversation_ref":"nf1_<64 lowercase hex>"
})
```

An explicit user request to read or change a mode is exact even in a limited
MCP client. A stateless client may set an account default without a
conversation reference, but it cannot persist a session override.

Policy v2 composes automatic tracking with saved project guidance and safe
artifact/version handling. Accounts or sessions that accepted policy v1 keep
the lifecycle-only behavior until they explicitly accept v2; do not silently
upgrade their contract.

## One conversation, one item

Maintain one root conversation and one Flow item for its goal. The root agent
owns automatic tracking. Subagents inherit the root conversation reference
when the host can propagate it and never create or ensure a second tracking
item, even when propagation is unavailable. Server idempotency is a safety net,
not permission to create parallel items.

An assigned worker with verified `remote_task`, `remote_push`, or
`process_step` claims uses its assigned item under every mode. `remote_task`
and `remote_push` follow the same work-mode ownership rule: call ensure only
when the host needs to confirm assignment reuse, accept the existing item, and
never create another item. Do not call conversation sync for assigned work;
the worker's existing task/lease lifecycle remains authoritative. A bare agent
key without a live assignment does not inherit a human default or gain tracking
authority.

## Lifecycle

The four lifecycle phases are:

1. `started` — the item was first ensured;
2. `scope_changed` — the material goal or acceptance boundary changed;
3. `blocked` — progress needs user input or an external state change; and
4. `completed` — the underlying work was verified, not merely attempted.

`ensure_session_work_item` is the sole operation that writes `started`. Never
send `started` to `sync_session_work_item`. Repeating ensure reuses the item and
does not create another started milestone. Sync accepts only `scope_changed`,
`blocked`, or verified `completed`.

Under policy v2, `completed` records a verified result and leaves the board
state unchanged. Move the item only as a separate ordinary state transition
that follows the current Flow, its gates, and optimistic state preconditions.
This keeps tracking completion from bypassing a human review column. Policy v1
retains its legacy lifecycle-only completion behavior for compatibility.

Ensure the item:

```text
execute_tool("ensure_session_work_item", {
  "workspace_slug":"acme",
  "project_identifier":"ENG",
  "conversation_ref":"nf1_<64 lowercase hex>",
  "title":"Implement portable Flow work modes",
  "summary":"Add user-selectable tracking across supported agents.",
  "call_origin":"automatic_tracking"
})
```

Sync one lifecycle milestone:

```text
execute_tool("sync_session_work_item", {
  "workspace_slug":"acme",
  "project_identifier":"ENG",
  "conversation_ref":"nf1_<64 lowercase hex>",
  "event_ref":"nfe1_<64 lowercase hex>",
  "phase":"blocked",
  "summary":"Waiting for the deployment environment to recover.",
  "call_origin":"automatic_tracking"
})
```

Resolve an exact workspace and project before automatic tracking. Never invent
a target. Mode selection authorizes only these bounded lifecycle writes; it
does not approve unrelated Flow mutations, broaden workspace access, or bypass
the host's existing approvals.

## Portable event identity

For each new logical sync milestone, allocate `event_nonce` as 16
cryptographically random bytes exactly once. Derive:

```text
event_bytes = UTF-8(conversation_ref) + 0x00 + ASCII(phase) + 0x00 + event_nonce
event_ref = "nfe1_" + lowercase_hex(SHA-256(event_bytes))
```

The nonce is raw bytes, not its hexadecimal text. The separators are one NUL
byte each. The shared conformance fixture is
`references/event-vectors.json`.

Before the first sync attempt, the root agent must freeze the
`(conversation_ref, phase, event_nonce, event_ref)` tuple in the minimal
in-session pending marker. Reuse the tuple verbatim for retries, resume,
compaction, and a partial-completion retry. Recomputing the same tuple must
produce the same reference. A later logical milestone gets a new nonce even
when phase or summary repeats. Never derive the reference from summary text or
time, reuse it for another phase, or regenerate it because a call failed.

If current state advances while Flow is unavailable, replace the one pending
marker with a newly allocated current-state event. Recovery writes current
state only and must never backfill abandoned intermediate events.

## Timeouts and fail-open recovery

Authenticated MCP initialization gets one write-free mode lookup under a hard
750 ms initialization deadline. If it fails, use Manual fallback guidance and
do not retry initialization.

Automatic Balanced or Strict tracking uses a single two-second budget for the
whole pipeline. The budget begins before project resolution and includes local
and remote target resolution plus API dispatch. A pre-dispatch timeout means
Flow is unavailable. A post-dispatch timeout is unknown: Nuanu Flow may commit late,
so never describe it as cancelled, failed, or definitely absent. Do not issue
an immediate retry.

Use `call_origin="explicit_user"` only for a direct user request to perform
that Flow operation. Explicit Manual operations retain the host's configured
tool timeout. Never mark an automatic call explicit to escape its two-second
budget.

For an automatic outage:

1. attempt the required Flow operation once;
2. warn the user once;
3. retain only one minimal in-conversation sync pending marker (including the
   frozen event tuple when applicable);
4. continue the underlying work;
5. retry at the next natural milestone or final response, not immediately; and
6. after recovery, write current state only—never backfill or replay a queue.

Reuse the same frozen identity when the pending logical state is still current,
so an unknown late commit and retry converge. If state advanced, replace it as
described above. Authentication, validation, and permission errors are not
outages and are not retried as outages. The final response distinguishes the
underlying work result from whether Flow synchronized.

## Data and host boundaries

Send only concise titles; current-status, blocker, or completion summaries;
exact target references; lifecycle phase; opaque conversation and event
references; client display name; and policy version.

Never send raw prompts, responses, reasoning, transcripts, logs, commands,
diffs, source files, environment values, credentials, or unrelated chat. Do
not create a local transcript, prompt queue, or background replay system.

In clients without hooks or persistent instructions, automatic Balanced and
Strict behavior is best effort. Querying and changing the mode plus explicit
Manual calls still work, but do not claim automatic enforcement when the host
cannot preserve instructions or conversation identity.

## Tools Used

`search_tools`, `execute_read_tool`, `execute_tool`, `get_work_mode`,
`set_work_mode`, `reset_work_mode`, `ensure_session_work_item`,
`sync_session_work_item`
