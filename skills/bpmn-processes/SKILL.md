---
name: bpmn-processes
description: Author and operate Nuanu Flow processes (BPMN workflows) — build the strict v1 graph, validate and activate templates, trigger runs, and operate typed tasks and Decisions.
---

# Processes (BPMN workflows)

A **process** is an automated corporate workflow: humans, AI agents, and
decision gates advance a run step by step. You author a process as a
**structured graph** (nodes + edges) — **never raw BPMN XML**. The server
compiles the graph to BPMN and draws the diagram; invalid graphs return
structural errors to fix.

**Validation is an authoring loop, not a user approval gate.** Once the user
has asked you to create or update a process, you are already authorized to fix
structural errors and warnings in that requested graph. Repair them and
revalidate immediately; do not stop at an error report or ask whether to
proceed. Ask the user only when the business outcome itself is ambiguous (for
example, an unspecified deny destination), not when a node merely needs to be
connected, removed, renamed, or rewired to satisfy validation.

Normally call `validate_process_graph` once after the complete semantic graph is
ready. Correct `blocking_errors` and revalidate, with a hard ceiling of
**three** calls per user turn. `advisory_warnings` describe capability or layout
observations and never authorize a contract rewrite or block saving.
`LAYOUT_EDGE_*` messages must never trigger node/edge permutations or another
validation call. Report a structural blocker if it remains after the
three-attempt budget.

For evidence-based comparison or self-improvement across process variants,
load `process-refine`; this skill remains responsible for normal authoring and
one-off operation.

Call pure reads via `execute_read_tool("<name>", {...})` and mutations via
`execute_tool("<name>", {...})`. Load only the needed section of this guide
with `get_bpmn_authoring_guide({section:"..."})`; start with `section:"index"`.
Use `search_process_patterns` and `get_process_pattern` for tested reusable
shapes instead of loading the full guide.

For an existing Process, first call `get_process_graph` with the default
`summary` view or a bounded `selection`. Make normal changes with
`patch_process_graph` and the returned `graph_hash`. The server applies the
semantic operations to the canonical graph, validates and compiles the complete
result, and saves it atomically. Do not reconstruct or resend the whole graph
for a one-node or one-edge edit. Full graph replacement is for initial creation,
explicit import, or an explicitly requested whole-graph rewrite.

A canonical operation name in this skill is guidance, not a current descriptor.
Summary candidates are not cacheable descriptors. Before direct execution, use
a matching cached full descriptor; otherwise make one `search_tools` lookup and
refine by canonical name or request `detail: "full"` to obtain the schema and
`schemaDigest`.

## The graph

```jsonc
{
  "schema_version": 1,
  "name": "Purchase Approval",
  "nodes": [
    /* … */
  ],
  "edges": [
    /* … */
  ],
}
```

### Node naming contract

Every node you author MUST have an immutable UUID `id`, a stable semantic
`key`, and an explicit, concise, human-readable `name`.
Never rely on the compiler to derive a visible label from the node `id`, and
never use generated BPMN identifiers such as `Activity_*`, `Event_*`, or
`Gateway_*` as names. The only exception is a server-generated immutable Column
Process Start node: preserve that node exactly as returned.

- Use `id` only as immutable internal identity. Generate a UUID for each new
  node and edge; preserve existing UUIDs on update.
- Use `key` as the stable lower-snake-case machine name, such as
  `write_stoic_story` or `review_story`. Handlebars and grouped inputs use keys,
  never UUIDs or generated BPMN element IDs.
- Use `name` as the short label people see in the editor: usually 2-5 words and
  no more than 40 characters.
- Name work nodes with clear actions: `Write Stoic story`, `Generate PDF`,
  `Send approval notice`.
- Name gateways and Decisions by their routing purpose or question: `Choose
story path`, `Review story`.
- Name End nodes by outcomes: `Story approved`, `Story rejected`.
- When updating a graph, name every new node and repair any touched node whose
  name is missing, generic, or derived from an identifier. Preserve meaningful
  existing ids, keys, and meaningful names.

Before validation, scan every authored node: `name` is non-empty, specific to
its job, and does not begin with a generated BPMN prefix.

### Node types

| `type`         | What it does                                                                                                                                                                                                                                                                                                     | Key graph shape                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start`        | Entry point (exactly one) and a platform-owned producing adapter. Its output is derived from its trigger; do not author or patch it.                                                                                                                                                                             | General: top-level `trigger:{mode:"manual"}`, `trigger:{mode:"schedule",cron:"…"}`, or an event trigger. Every Start emits `data.trigger` and `data.invoked_at`; manual/event starts also emit `data.payload`. A Flow-item Start emits `artifacts.flow_item` as an exact versioned source Artifact. Preserve a Column Start exactly.                                                 |
| `end`          | Terminates a branch (≥1). A Column Process End declares the intended next project status; the Flow item's execution mode decides whether it is applied.                                                                                                                                                          | Column Process v1: `config.project_status:{target_state_id:"EXACT_STATE_UUID"\|null}`. `null` keeps the current status.                                                                                                                                                                                                                                                              |
| `human_task`   | Pauses; creates a task whose person-supplied result must match the strict Process output contract.                                                                                                                                                                                                               | `name`, `priority`, `assignee_ids:[…]`, `assign:{mode:"function",function_id,scope}`, optional `require_completion_comment:true`, and minimal `config.output`. The runtime generates the completion form from `output`; do not author legacy completion requirements.                                                                                                                |
| `agent_task`   | Transforms its immediate `InputSet` into one strict `FlowStepResultV1`.                                                                                                                                                                                                                                          | `config.agent_employee_id`, `instruction` using `{{input.<source_key>...}}`, and minimal `config.output`. Optional capability labels live only at `config.runtime_hints.required_worker_capabilities` and are informational. For a Flow-item Column Process, optional `config.handoff_policy` can project recognized stage results into Activity comments and exact causal guidance. |
| `decision`     | A BPMN UserTask reducer that selects exactly one candidate item.                                                                                                                                                                                                                                                 | `config.response_mode:"choice"`, title/description, exactly one assignee, and optional structured `source:{step_key,data_field}`. It emits the selected candidate unchanged.                                                                                                                                                                                                         |
| `gateway`      | A branch/merge point. `kind` picks the semantics: `"exclusive"` (XOR, default — exactly ONE outgoing path, by conditions or an AI judge), `"parallel"` (AND — fork takes ALL paths; a same-kind join waits for all of them), `"inclusive"` (OR — every matching condition path; join waits for the active ones). | `kind:"exclusive"\|"parallel"\|"inclusive"`, `{mode:"simple"}` or `{mode:"ai",agent_employee_id,prompt}` (exclusive only), `join_timeout` on a converging gateway                                                                                                                                                                                                                    |
| `notification` | Fire-and-forget message; does not wait.                                                                                                                                                                                                                                                                          | `message`, `recipient_ids:[…]`                                                                                                                                                                                                                                                                                                                                                       |
| `webhook`      | Calls an external URL, waits for the response.                                                                                                                                                                                                                                                                   | `url`, `payload:{…}`                                                                                                                                                                                                                                                                                                                                                                 |

Every decision also needs a resolvable human owner. Call
`list_workspace_members` before assigning a person, and use a returned member ID
or a complete function assignment. Never leave a decision unassigned.

### Edges

`{"id":"<UUID>","source":"<node UUID>","target":"<node UUID>","when":<condition?>}`. `when` is only
for edges **out of a gateway or decision**:

- **Decision outcome** — `{"outcome":"approve"}` (values: `approve`, `deny`, `refine`, or `option:<value>`). Several outcomes sharing one target take a **list**: `{"outcome":["option:a","option:b"]}` — never author parallel duplicate edges to the same node.
- **Otherwise** — `{"otherwise":true}` — the fallback branch when nothing else matches (one per gateway).
- **Condition** — `{"var":"quote.amount","op":"gt","value":1000}`. Ops: `eq neq gt lt gte lte contains empty notEmpty isTrue isFalse`.
- **AI-judge branch** — `{"branch":"needs_review"}` — the branch name the judge agent chooses.

## Linear data movement and Handlebars

Authors edit outputs; inputs are always derived from the BPMN topology and are
read-only. An activity receives only its immediate data-producing predecessors:

```json
{
  "input": {
    "write_story": { "key": "write_story", "description": "...", "data": { "story": "..." }, "artifacts": {} }
  }
}
```

Use only paths shown by validation/read-back:

- `{{input.write_story.data.story}}`
- `{{input.generate_image.artifacts.hero_image.artifact_id}}`
- `{{input.choose_concept.key}}` after a Choice reducer

For a Decision that reviews and sends the exact image file, use that same input
path directly in the authored body and delivery configuration:

```jsonc
{
  "body": "{{input.generate_image.artifacts.hero_image}}",
  "deliver_artifacts": true,
  "delivery_channels": ["in_app", "telegram"],
}
```

After saving, read it back and verify that the exact input path and delivery
settings are still present.

Do not author `input`, `input_bindings`, `${steps...}`, a process-wide context
bag, or backward lookups. A gateway routes/synchronizes tokens and never emits
or transforms data. After XOR, one active source is present. After a structured
parallel/inclusive join, the next activity receives a source-keyed object of
the terminal active branch outputs.

## Project Processes — Column and General

There are two project Process kinds:

- **Column Process** — bound to one exact project state. It can participate in
  one continuous Flow-item journey across multiple state entries and runs.
- **General Process** — project-scoped but not state-owning. V1 supports only
  explicit Manual and Schedule triggers; a schedule needs an explicit cron.
  It never gains journey control implicitly.

### Create and edit a Column Process

1. Read the project states and ask which exact state owns the Column Process.
2. Call `create_project_process_binding` with `kind:"column"`, the exact
   `project_state_id`. The server creates a valid v1 skeleton and owns its
   binding metadata.
3. Read the returned binding and then `get_process_template`. Its Start node
   contains a generated contract like this:

```jsonc
{
  "id": "<UUID>",
  "key": "project_start",
  "type": "start",
  "name": "Project start",
  "config": {
    "project_process_start": {
      "binding_id": "…",
      "project_id": "…",
      "state_id": "…",
    },
  },
}
```

Preserve that Start node and all three values exactly. Do not delete it, copy
it into a generic template, or change its state through graph editing. Raw
BPMN replacement is not supported for Column Processes.

The generated Start output is platform-owned and reads as:

```jsonc
{
  "data": {
    "trigger": { "type": "string", "description": "How this Process run started" },
    "invoked_at": { "type": "string", "description": "When this Process run was invoked" },
  },
  "artifacts": {
    "flow_item": {
      "description": "Exact Flow item snapshot that invoked this Process",
      "kind": "flow_item",
    },
  },
}
```

Consume it as `{{input.project_start.data.invoked_at}}` and
`{{input.project_start.artifacts.flow_item}}`. The Artifact reference pins an
immutable Flow-item snapshot; do not replace it with copied fields from a
generic payload.

4. Insert tasks, agents, Decisions, gates, notifications, and artifacts between
   Start and End. Put human approval **inside the BPMN** as a Decision before
   the relevant End; the End status target is not a second approval gate.
5. Give every successful End a `config.project_status`:

```jsonc
{
  "id": "approved",
  "type": "end",
  "name": "Move to QA",
  "config": {
    "project_status": {
      "target_state_id": "EXACT_QA_STATE_UUID",
    },
  },
}
```

Use the exact target status UUID from Project Settings. Use
`{"target_state_id":null}` to keep the current status. The same BPMN graph is
used by Manual, Assist, and Auto Flow items.

6. Validate the complete graph, update the template, read it back, then call
   `activate_project_process_binding` only when activation was requested.
   `activate_process_template` is for ordinary workspace templates and must not
   bypass binding validation.

### Modes and safety

| Flow-item mode | When the item enters a bound status      | When the Process reaches an End                                          |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| **Manual**     | Does not start automatically.            | Records the intended status but does not move the item.                  |
| **Assist**     | Starts the shared Process automatically. | Records the intended status but leaves the move to a person.             |
| **Auto**       | Starts the shared Process automatically. | Applies the intended status and may continue into the next bound status. |

The mode belongs to the Flow item, not the binding or BPMN graph. Each run
freezes the item's mode when it starts, so changing the selector applies only
to a later run. The system stops a journey before a 13th automatic status
transition; this safety limit is not user-configurable.

### Run, poll, and hand control back

- Use `run_flow_item_column_process` for one explicit start. It uses the Flow
  item's current mode; there is no action discriminator. Reuse an
  `idempotency_key` when retrying the same request.
- Read `get_flow_item_process_control`, then poll
  `get_project_process_journey` after runs and Decisions. A journey spans the
  related Column Process runs; its counters, state visits, and transition
  receipts are the authority for automation budgets and applied outcomes.
- A `409 process_control_conflict` is not permission to mutate control. Show
  its `journey_id`, `process_run_id`, and `allowed_actions`; let the user choose.
- `stop_flow_item_process` and `take_over_flow_item_process` cancel active
  process work without silently changing the selected item mode. Explain that
  effect, obtain explicit confirmation, and only then pass the tool's
  confirmation flag. Never invoke either as silent conflict recovery.

For a General binding, call `create_project_process_binding` with
`kind:"general"` plus an explicit Manual or Schedule trigger. Author its
ordinary template using the normal validation lifecycle below. A General
Process has no generated project Start, no Flow-item status End, and no
journey unless a separate explicit controlled action creates one.

## Choice Decisions in Process v1

A Choice Decision is a reducer, not an approve/refine/deny form. Its immediate
input must contain exactly one `choices`-typed data field, or `config.source`
must select one explicitly:

```jsonc
{
  "id": "<UUID>",
  "key": "choose_concept",
  "type": "decision",
  "name": "Choose concept",
  "config": {
    "response_mode": "choice",
    "title": "Choose one direction",
    "assignee_ids": ["MEMBER_UUID"],
    "source": { "step_key": "propose_concepts", "data_field": "choices" },
  },
}
```

The producer declares `choices` under `config.output.data`. Each authored
runtime choice is a keyed ProcessItem draft with the same
`{key,description,data,artifacts}` shape. Nuanu adds the system-owned successful
`outcome` when the result is admitted.
The human selects one value; the Decision emits that candidate unchanged.
Downstream reads `{{input.choose_concept.key}}` and the selected item's fields.
Never create `choice1`/`choice2`, positional arrays, static Decision options,
or approval/refinement fields for a Process v1 Choice.

### ProcessItem v1 Agent Task output contract

Every editable producing activity declares one minimal `config.output` object;
Start is the platform-owned exception described above. Data
fields need a name, type, and natural-language description. Artifact fields
need a semantic name, description, and durable Artifact kind. They may also
declare an optional closed `restrictions` object when the runtime
representation truly requires a specific MIME type:

```jsonc
{
  "id": "<UUID>",
  "key": "generate_image",
  "type": "agent_task",
  "name": "Generate image",
  "config": {
    "agent_employee_id": "AGENT_UUID",
    "instruction": "Generate an image for {{input.write_story.data.story}}.",
    "failure_handling": { "mode": "continue" },
    "output": {
      "data": {
        "caption": { "type": "string", "description": "Caption for the image" },
      },
      "artifacts": {
        "hero_image": {
          "description": "Generated full-resolution hero image",
          "kind": "image",
          "restrictions": { "media_types": ["image/png", "image/jpeg"] },
        },
      },
    },
    "runtime_hints": {
      "required_worker_capabilities": ["image_generation_v1"],
    },
  },
}
```

`failure_handling` is optional and valid only on Agent Tasks. Omit it or use
`{"mode":"stop"}` to fail the Process when the Agent fails. Use
`{"mode":"continue"}` when the Process should carry a typed failure to the next
step. `continue` completes the Agent Task through its ordinary BPMN sequence
flow with one failed ProcessItem. Do not add an Error Boundary Event or merge
for this policy, and do not weaken a parallel join: it remains a strict BPMN
AND join and receives exactly one ordinary token from every branch.

For a Flow-item Column Process, an Agent Task may also opt into:

```json
"handoff_policy": {
  "activity_comments": "off | negative | all",
  "downstream_context": true
}
```

This is presentation and context policy, not routing. `activity_comments`
controls concise, immutable Activity comments for recognized structured stage
results (`implementation`, `review`, and `qa`); `negative` publishes only
review/QA results that need attention. `downstream_context:true` appends only
the exact handoff that caused the current status entry to the next Agent Task.
It never exposes unrelated history and never chooses an edge or status. Omit
the policy for ordinary Process data flow.

For any other collaboration pattern, keep the business logic in BPMN and let
the Agent use its granted Flow-item MCP tools. The pinned `flow_item` Start
Artifact identifies the case; `get_issue_comments` reads its human discussion
and `add_issue_comment` can publish a concise handoff when the Agent is allowed
to do so. Comments are case communication, not machine routing conditions.
Use declared Process outputs and gateways for routing and state changes.

Allowed data types are `string`, `number`, `boolean`, `json`, and `choices`.
For `choices`, add `item:{data:{...},artifacts:{...}}` to declare the shared
candidate shape. `runtime_hints` are diagnostic only and never block claim or
execution. Omit `restrictions` to allow any MIME type. When present,
`restrictions.media_types` contains 1–20 unique normalized lowercase MIME
types without parameters and is enforced against the stored Artifact version
for both Human and Agent Tasks. Do not use legacy `artifact_rules`, top-level
`mime_type`, role/kind matching, `required_worker_capabilities` at the config
root, or the name `generate_pdf` unless that is genuinely the authored
semantic step key.

At runtime, the activity returns exactly:

```json
{
  "schema_version": "nuanu.flow-step-result.v1",
  "item": {
    "key": "generate_image",
    "description": "Generated the hero image.",
    "data": { "caption": "..." },
    "artifacts": { "hero_image": { "artifact_id": "...", "version_id": "...", "kind": "image", "role": "output" } }
  }
}
```

The Agent authors only `key`, `description`, `data`, and `artifacts`. Nuanu adds
`"outcome":{"status":"completed"}` after successful admission. A caught failure
instead produces this system-owned item under the same semantic step key:

```json
{
  "key": "generate_image",
  "description": "Generate image failed and the Process continued.",
  "outcome": {
    "status": "failed",
    "error": { "code": "provider_error", "message": "...", "retryable": false }
  },
  "data": {},
  "artifacts": {}
}
```

Downstream steps test `{{input.generate_image.outcome.status}}` and may read the
typed error. Failure items never carry partial authored data or Artifacts.

Multiple Artifacts are separate named properties. Every reference pins an exact
stored `version_id`; never use an anonymous array or mutable latest-version
lookup.

When creating a **local** Agent Employee for a step with declared Artifact
outputs, attach the curated `artifacts` skill and publish that Agent version
before binding it. Do not assume a document-writing prompt teaches Artifact
publication. The exact pinned local Agent version is authoritative: Process
execution may preload a required skill that is already attached, but it never
silently injects a missing skill. A missing `artifacts` skill is a deterministic
validation/runtime prerequisite error. Use `patch_agent_draft` to add the exact
curated skill, explicitly publish a new immutable Agent version after approval,
then patch the Process step to that exact version. The agent must call the
Artifact MCP, use returned IDs, and include `role:"output"`—never fabricate a
reference.

A Nuanu-native remote Agent is different: the remote worker runs with the
combined Nuanu Flow plugin installed and therefore has the full bundled skill
set, including `artifacts`. Its attached `skills` array may be empty and must not
be interpreted as a missing Artifact skill. External A2A Agents do not inherit
that promise; use only their advertised Agent Card capabilities.

Match the declared media type to a capability the bound runtime can really
produce. A local text-only agent can publish a Markdown document through the
Artifact MCP, so use `text/markdown` and a `.md` filename for that case. Declare
`application/pdf` only when the agent or worker has a real PDF-producing tool;
renaming text to `.pdf` is not valid PDF generation and will fail Artifact
verification.

Before binding the step, inspect the agent returned by `list_agents`, including
its `capabilities` block. If the graph pins `agent_version_id`, also call
`get_agent_version` and verify the exact published snapshot; draft capabilities
do not upgrade a pinned version. Capability labels and
`runtime_hints.required_worker_capabilities` are informational diagnostics, not
an admission gate. They may justify a warning or a recommendation to rebind,
but they must not block a valid graph or silently downgrade the requested
Artifact kind/media type. The `artifacts` skill provides publication
instructions, not PDF/image/audio rendering.
Interpret `capabilities.skill_availability` by runtime: exact attached skills for
local Agents, the full installed plugin bundle for Nuanu-native remote Agents,
and advertised-only capabilities for external A2A Agents.

## Gateways — pick the right kind, close what you open

- **Exclusive (XOR, default)** — exactly one outgoing path. Route with edge
  conditions + one `otherwise`, or `{mode:"ai"}` with named-`branch` edges (a
  judge agent picks ONE branch — AI mode is exclusive-only).
- **Parallel (AND)** — the fork takes ALL outgoing paths unconditionally (never
  put conditions on its edges). Every fork needs a converging gateway of the
  SAME kind to close it. The join holds until every branch token arrives, then
  continues once. It emits no data. The next activity receives each terminal
  branch `ProcessItem` grouped by its source key. Set `join_timeout` on the join.
- **Inclusive (OR)** — takes every path whose condition matches (give one edge
  `{"otherwise": true}` so at least one is taken). Close with an inclusive
  join — it waits only for the branches that were actually taken.
- **Aggregating branch results ("AI merge")** — a join only synchronizes; it
  does not combine data. To merge what the branches produced, put an
  `agent_task` right AFTER the join whose instruction reads each branch's
  grouped input (`{{input.branch_a.data.field}}`,
  `{{input.branch_b.data.field}}`) and emits a new declared output.

## Visual layout contract and deterministic authoring order

The compiler owns BPMN coordinates, ports, connection waypoints, and collision
diagnostics. The graph expresses semantic structure and stable sibling order:

- Keep the normal forward path on one horizontal **main spine**: start, fork,
  join, synthesis, decision, approved work, and approved end should progress
  left to right.
- Treat every fork and matching same-kind join as one structured block. Put
  the fork first, then branch nodes in the desired **top-to-bottom order**, then
  the join. Keep both the fork's outgoing edges and the join's incoming edges
  in that same order.
- Give an exclusive fork the same deterministic structure even though it has no
  join: choose the top-to-bottom branch order once, list each branch as one
  contiguous forward block, and never interleave nodes from sibling branches.
  Within a branch, list proposal/work steps first, then its decision, branch-local
  follow-up work, and branch-local Ends.
- Put parallel branch steps in shared phase columns with even vertical spacing.
  Branches doing equivalent work should start at the same x-position and reach
  the join at the same x-position; avoid staggered boxes and diagonal crossing
  lines unless the branch truly has extra steps.
- Keep related decision exits in stable lanes. The approve path stays on the
  main spine; a direct deny/reject end uses one short **outward** exit lane
  (above an upper branch, below a lower branch); a refine edge returns to the
  proposal-producing step through a branch-local return lane.
- Give separate semantic exits separate nearby end nodes. Reusing a distant end
  across decisions creates long wires and an ambiguous diagram.
- Preserve semantic branch order when updating a process. Never reorder nodes
  or edges solely to influence geometry. If validation returns a
  `LAYOUT_EDGE_*` diagnostic, keep the graph unchanged and continue when it is
  otherwise structurally ready; routing repair belongs to the compiler.

Screenshot capture and model-based visual inspection are optional QA. Use them
only when the active runtime declares image/vision support. Otherwise skip them
without an error and rely on deterministic compiler diagnostics; lack of vision
never blocks validation, saving, or activation.

Before validation, verify the complete graph—not just its shape:

- `schema_version` is exactly `1`; every node and edge has an immutable UUID,
  every node has a unique semantic `key`, and edges use `source`/`target` UUIDs.
- `nodes` and `edges` are both inside the `graph` object.
- Every editable producing activity declares `config.output:{data,artifacts}`;
  Start output is derived from its trigger. No node declares inputs,
  `input_bindings`, or `artifact_rules`.
- Every parallel/inclusive branch has a statically identifiable terminal
  producer; the matching join is paired and the post-join activity reads the
  grouped `input.<source_key>` entries.
- A Choice producer declares one named `choices` field and candidate item
  schema. The Choice Decision has `response_mode:"choice"`, one assignee, and
  an explicit structured source only when auto-detection would be ambiguous.
- Every decision has non-empty `assignee_ids` or a complete function
  assignment (`mode:"function"` plus `function_id`).
- Each named Artifact output has `description`, `kind`, and optionally
  `restrictions.media_types`. The agent returns one exact immutable reference
  under that same name and the runtime checks the stored MIME type.
- `runtime_hints.required_worker_capabilities` may describe preferred runtime
  support, but it is informational and must never be treated as an admission
  gate.
- `handoff_policy` is optional and closed: `activity_comments` is `off`,
  `negative`, or `all`, and `downstream_context` is boolean. It does not add an
  edge, change a status, or replace an authored Process output.

## Patterns

- **AI triage** — an exclusive `gateway` with `{mode:"ai",prompt:"…"}` and named-`branch`
  edges; a judge agent routes.
- **Parallel work** — fork with `{kind:"parallel"}`, close with a `{kind:"parallel"}` join (+ `join_timeout`), then an AI-merge `agent_task` after the join when branch outputs need combining.

## Lifecycle

1. For a new graph, load only the relevant guide sections/patterns and call
   `list_agents` before assigning an `agent_task` or AI gateway. Inspect the
   returned capability configuration and use `get_agent_version` when pinning
   an exact version. A human-only graph does not need an agent lookup.
2. For an existing graph, finish every supporting lookup first (for example
   Agent/version discovery or a pattern lookup). Then, in the current user
   turn and immediately before the first patch, call `get_process_graph`:
   - use `summary` to discover its topology and size;
   - use `selection` with exact node keys plus neighbors/incident edges for a
     bounded edit;
   - use `full` only for broad topology work or explicit inspection.
     The response includes topology-derived input paths. Use those exact paths;
     do not infer a process-wide context or manually author inputs.
     The returned `definition_etag` is a short-lived edit lease for the exact
     persisted BPMN definition. Never reuse one from an earlier user turn, an
     earlier mutation receipt, or a read performed before dependent lookups.
3. For initial creation, call `validate_process_graph` with the complete graph,
   correct only `blocking_errors`, then call `create_process_template`. For an
   existing graph, call `patch_process_graph` with the fresh
   `expected_definition_etag` and a minimal ordered operation list. It validates
   and compiles the final graph in the same transaction, so a separate
   full-graph validation/update pair is not required. `update_node.patch` and
   `update_edge.patch` use JSON Merge Patch: set a nested key to `null` to
   remove it; `{}` preserves the existing object. On `409
STALE_PROCESS_GRAPH`, use the returned recovery selection, re-read it, and
   retry at most once only when the user's original intent is still valid.
   Never auto-merge, overwrite, guess, or loop on a stale definition.
4. Treat `advisory_warnings` as read-only evidence. Layout/capability warnings
   do not block, trigger retries, or permit an Artifact/output contract change.
   If blocking diagnostics remain after three authoring attempts, report them
   instead of looping or claiming the process was saved.
5. Verify the mutation receipt and read back the touched selection with
   `get_process_graph`. For a Column Process, create the binding first, preserve
   its generated Start, and patch only the editable graph elements.
6. `activate_process_template` only when the user explicitly asks; read it back
   before claiming it is active. `deactivate_process_template` pauses new runs.
7. `trigger_process_run` with `template_id` plus optional `context_data`. The
   Start adapter always exposes `trigger` and `invoked_at`; manual/event starts
   also expose `payload`, while Flow-item starts expose the exact
   `artifacts.flow_item` reference. The next activity reads them under
   `{{input.<start_key>.data.<field>}}` or
   `{{input.<start_key>.artifacts.flow_item}}`.
8. Operate the run:
   - `get_process_run` / `get_process_run_status` — status, current step,
     step logs. `list_process_runs` for history.
   - `list_process_tasks` / `get_process_task` — open human tasks and inspect
     their exact inputs, output definition, saved draft, and readiness. Use
     `save_process_task_output`, then `complete_process_task` with a stable
     idempotency key. In the UI, each required scalar, Choice candidate, and
     Artifact slot is a generated control; a stored Artifact picker pins an
     exact version, temporary uploads are run-scoped, and Ready appears only
     when the complete schema matches. MCP supplies the same draft shape with
     exact stored Artifact references. Use task comments for collaboration;
     comments never satisfy declared outputs.
   - resolve the exact typed Decision created for the waiting step. A Choice
     Decision selects one immutable ProcessItem candidate by key.
   - on failure, call `get_process_run_failure` before broad run inspection. It
     returns the failed step, exact Agent/version binding, bounded adjacent
     inputs/outputs, Artifact references, and safe typed diagnostics without
     raw prompts or an entire run payload.

A tool-bearing turn is work in progress. Never claim a mutation succeeded
before its tool result and read-back, and never continue with a guessed id
after a failed create or update. A valid dry-run result is not task completion;
the requested mutation and read-back must still happen.

When showing a run to the user, prefer the plugin's terminal diagram over
prose: `node <plugin>/scripts/render/render.mjs run <runId>` prints the graph
with live step statuses (`✓ ▶ ○ ✗`); `watch <runId> --until done --timeout N`
follows it. Requires NUANU_URL + NUANU_TOKEN env.

## Rules

- Exactly one `start`; every node reachable from it; every `end` reachable.
- Every agent-authored node has an explicit short `name`; never finalize a graph
  whose visible label would fall back to `Activity_*`, `Event_*`, `Gateway_*`,
  or another machine identifier.
- Give an `otherwise` branch to any gateway that can "fall through".
- **Before assigning an agent, call `list_agents`** and use only ids it returns for
  `agent_employee_id` (agent tasks AND AI-judge gateways). Verify the returned
  model/tools/skills/integrations against the step's declared outputs, and
  inspect `get_agent_version` for a pinned version. A stale/foreign id is a
  blocking identity error. For a local Artifact-producing step, the exact
  pinned snapshot must contain the curated `artifacts` skill. Output-capability
  observations remain advisory and never block MCP save preflight. For a
  Nuanu-native remote step, `capabilities.skills:[]` is expected because the
  installed plugin supplies the full bundled skill set; never add or require a
  local curated-skill attachment for that runtime.
- Reference only fields exposed by the receiving node's derived immediate
  inputs, using `{{input.<source_key>.data.<field>}}`,
  `{{input.<source_key>.artifacts.<name>...}}`, or the selected Choice item.
- `validate_process_graph` separates `blocking_errors` from
  `advisory_warnings`. Fix blocking structural, identity, assignment, exact
  skill, and invalid data-path diagnostics. Capability and `LAYOUT_EDGE_*`
  warnings are advisory immediately. Never reorder or revalidate solely for
  layout. A task is finalized only after the mutation receipt and bounded graph
  read-back agree.
- You never write BPMN XML, inputs, namespaces, or data associations — the
  compiler derives them from the Process v1 graph and BPMN topology. Author the
  graph; read it back with `get_process_graph`.
- A generated `project_process_start` is server-owned and immutable. Every
  Column Process End has a `project_status.target_state_id`; item modes, target
  states, stop, and takeover remain explicit choices.

## Tools Used

`execute_read_tool`, `execute_tool`, `list_agents`, `get_agent_version`, `patch_agent_draft`,
`publish_agent_version`, `list_workspace_members`,
`list_project_process_bindings`, `get_project_process_binding`,
`create_project_process_binding`, `activate_project_process_binding`,
`pause_project_process_binding`, `list_project_process_journeys`,
`get_project_process_journey`, `run_flow_item_column_process`,
`get_flow_item_process_control`, `stop_flow_item_process`,
`take_over_flow_item_process`, `create_process_template`,
`get_process_graph`, `patch_process_graph`, `get_process_template`,
`list_process_templates`, `delete_process_template`,
`validate_process_graph`, `activate_process_template`,
`deactivate_process_template`, `trigger_process_run`, `get_process_run`,
`get_process_run_status`, `get_process_run_failure`, `list_process_runs`,
`list_process_tasks`, `get_process_task`, `update_process_task`,
`save_process_task_output`, `complete_process_task`,
`list_process_task_comments`, `add_process_task_comment`,
`get_bpmn_authoring_guide`, `search_process_patterns`, `get_process_pattern`
