# Processes (BPMN workflows)

A **process** is an automated corporate workflow: humans, AI agents, and
decision gates advance a run step by step. You author a process as a
**structured graph** (nodes + edges) — **never raw BPMN XML**. The server
compiles the graph to BPMN and draws the diagram; invalid graphs return
structural errors to fix.

For evidence-based comparison or self-improvement across process variants,
load `process-refine`; this skill remains responsible for normal authoring and
one-off operation.

Call tools via `execute_tool("<name>", {...})`. The server also exposes this
guide at runtime via `get_bpmn_authoring_guide`.

## The graph

```jsonc
{
  "name": "Purchase Approval",
  "nodes": [
    /* … */
  ],
  "edges": [
    /* … */
  ],
}
```

Give every node a concise human-readable `name`. Node ids are for references;
names are the labels people see in the process editor.

### Node types

| `type`         | What it does                                                                                                                                                                                                                                                                                                     | Key `config`                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start`        | Entry point (exactly one).                                                                                                                                                                                                                                                                                       | `trigger`: `{mode:"manual"}` \| `{mode:"schedule",cron:"0 9 * * *"}` \| `{mode:"event",event:"issue_created"}`                                                                                                                                                                                                                                                                                               |
| `end`          | Terminates a branch (≥1).                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                            |
| `human_task`   | Pauses; creates a task a person must complete.                                                                                                                                                                                                                                                                   | `name`, `priority`, `assignee_ids:[…]`, `assign:{mode:"function",function_id,scope}`, `completion_requirements:[…]`                                                                                                                                                                                                                                                                                          |
| `agent_task`   | Runs an AI agent, captures its output.                                                                                                                                                                                                                                                                           | `agent_employee_id`, `instruction` (Handlebars) — plus node-level `output:[{name,type}]` for structured fields. To store a genuine PDF after success: `artifact_output:"pdf"`, `artifact_content_field:"<output field>"`, `artifact_name:"Report.pdf"`                                                                                                                                                       |
| `decision`     | Pauses; asks a person to approve / deny / refine / pick an option; the choice routes the flow.                                                                                                                                                                                                                   | `title`, `description` (the question), `body` (the proposal, Handlebars; embed a produced file with `{{artifact stepId}}`), `approval_mode:"any"\|"consensus"`; assign people with `assignee_ids:[…]` or a function with `assign:{mode:"function",function_id,scope}`; choices: `options_mode:"agent"` + `options_from:"<agentStepId>"` for agent-proposed rich options, or static `options:[{value,label}]` |
| `gateway`      | A branch/merge point. `kind` picks the semantics: `"exclusive"` (XOR, default — exactly ONE outgoing path, by conditions or an AI judge), `"parallel"` (AND — fork takes ALL paths; a same-kind join waits for all of them), `"inclusive"` (OR — every matching condition path; join waits for the active ones). | `kind:"exclusive"\|"parallel"\|"inclusive"`, `{mode:"simple"}` or `{mode:"ai",agent_employee_id,prompt}` (exclusive only), `join_timeout` on a converging gateway                                                                                                                                                                                                                                            |
| `notification` | Fire-and-forget message; does not wait.                                                                                                                                                                                                                                                                          | `message`, `recipient_ids:[…]`                                                                                                                                                                                                                                                                                                                                                                               |
| `webhook`      | Calls an external URL, waits for the response.                                                                                                                                                                                                                                                                   | `url`, `payload:{…}`                                                                                                                                                                                                                                                                                                                                                                                         |

### Edges

`{"from": "<nodeId>", "to": "<nodeId>", "when": <condition?>}`. `when` is only
for edges **out of a gateway or decision**:

- **Decision outcome** — `{"outcome":"approve"}` (values: `approve`, `deny`, `refine`, or `option:<value>`). Several outcomes sharing one target take a **list**: `{"outcome":["option:a","option:b"]}` — never author parallel duplicate edges to the same node.
- **Otherwise** — `{"otherwise":true}` — the fallback branch when nothing else matches (one per gateway).
- **Condition** — `{"var":"quote.amount","op":"gt","value":1000}`. Ops: `eq neq gt lt gte lte contains empty notEmpty isTrue isFalse`.
- **AI-judge branch** — `{"branch":"needs_review"}` — the branch name the judge agent chooses.

## Variables — how steps pass data

Every step's output is stored **namespaced by its node id**. Reference it
anywhere a string is accepted (instructions, messages, conditions) as
`{{nodeId.field}}`:

- An `agent_task` with `output:[{name:"amount"}]` → later `{{quote.amount}}`.
- A `decision` → `{{approve.resolution}}` (`approve`/`reject`/…) and `{{approve.selected_option}}`.
- A `human_task` with a completion requirement keyed `note` → `{{review.note}}`.
- The `start` payload → `{{start.<field>}}`.

Conditions read the same paths: `{"var":"approve.resolution","op":"eq","value":"approve"}`.

## Worked example — quote → approve → fulfil / reject

```jsonc
{
  "name": "Purchase Approval",
  "nodes": [
    { "id": "start", "type": "start", "trigger": { "mode": "manual" } },
    {
      "id": "quote",
      "type": "agent_task",
      "name": "Draft quote",
      "config": { "agent_employee_id": "AG1", "instruction": "Quote for: {{start.request}}" },
      "output": [{ "name": "amount", "type": "number" }],
    },
    {
      "id": "approve",
      "type": "decision",
      "name": "Approve quote?",
      "config": {
        "approval_mode": "consensus",
        "assign": { "mode": "function", "function_id": "FIN" },
        "body": "Quote: {{quote.amount}} for {{start.request}}",
      },
    },
    {
      "id": "fulfil",
      "type": "agent_task",
      "config": { "agent_employee_id": "AG1", "instruction": "Fulfil {{quote.amount}}" },
    },
    { "id": "end_ok", "type": "end" },
    { "id": "end_no", "type": "end" },
  ],
  "edges": [
    { "from": "start", "to": "quote" },
    { "from": "quote", "to": "approve" },
    { "from": "approve", "to": "fulfil", "when": { "outcome": "approve" } },
    { "from": "approve", "to": "quote", "when": { "outcome": "refine" } },
    { "from": "approve", "to": "end_no", "when": { "outcome": "deny" } },
    { "from": "fulfil", "to": "end_ok" },
  ],
}
```

## Decisions — wire all three outcomes

Every decision resolves to `approve`, `deny`, or `refine` (plus `option:<value>`
picks). Wire each deliberately:

- **approve** (or an `option:` pick) → moves the flow **forward**.
- **refine** → edges **back to the step that produced the proposal** (usually
  the upstream `agent_task`); the agent reworks with the reviewer's feedback
  and the same decision reopens. Without this back-edge, refine does nothing.
- **deny** → its **own branch**, usually a separate end event — never the same
  end as approve. If the user hasn't said what deny should do, **ask them**
  before authoring; don't guess.

Every decision also needs a resolvable human owner. Call
`list_workspace_members` and assign explicit member UUIDs with
`config.assignee_ids`, or use a complete function assignment. When the user
says “validate with me” or “ask me,” resolve the requesting user from available
host identity context; if that identity is unavailable or ambiguous, ask one
compact question before saving. Never leave a decision unassigned: it shows an
editor warning and the run will fail when it reaches that step.

**Agent-fed choices**: when an upstream agent produces the things being chosen
between, do NOT author static `options:[{value,label}]` (they render as bare
labels like "Option 1"). Set `options_mode:"agent"` +
`options_from:"<agentStepId>"` on the decision instead — the agent is asked to propose the options. The source step's reply shape is then FIXED to `{options, output}` — never declare an `output` schema on it (ignored, and MCP mutation preflight rejects the warning); need structured fields from the pick? Add a separate agent step after the decision. Do not reference an invented field such as `{{proposal.proposals}}`; omit `body` or use the source's real `{{proposal.output}}`. Each option renders with a full rich-text body in the
Decisions inbox. A pick approves the decision, so route forward on
`{"outcome":"approve"}` and read `{{<decisionId>.selected_option}}` downstream.

### Reviewing artifacts in a decision

When a person must review a file produced by an upstream step, embed it in the
decision `body` with `{{artifact <stepId>}}`. For example:

```jsonc
{
  "id": "review_report",
  "type": "decision",
  "name": "Review PDF report",
  "config": {
    "title": "Approve the research report?",
    "body": "Review the generated report below.\n\n{{artifact generate_pdf}}",
    "assignee_ids": ["MEMBER_UUID"],
    "auto_include_upstream_artifacts": true,
    "deliver_artifacts": true,
    "delivery_channels": ["in_app", "telegram"],
  },
}
```

This is a typed artifact reference, not text interpolation. At run time Nuanu
Flow resolves it to the exact immutable Artifact version produced by that step,
renders it in the Decision, and attaches that frozen version on enabled
external channels. Never substitute the PDF source text into the Decision body
or invent a download URL.

- Use `artifact_refs:[…]` only for explicit pre-existing Artifacts.
- `auto_include_upstream_artifacts` defaults to `true`: when no helper or
  explicit refs are authored, the nearest produced artifact on each completed
  upstream branch is included.
- `deliver_artifacts` defaults to `true`; set it to `false` only when external
  channels should receive the Decision card without its reviewed artifacts.
- A missing, deleted, unuploaded, or out-of-run helper target is a run error.
  Fix the producer or the helper; never silently drop the artifact.

Treat user wording such as “send the artifact as a file,” “show the PDF in the
decision,” or “attach it in Telegram” as this exact pattern. The artifact
belongs to the Decision: put `{{artifact <producerStepId>}}` in its `body`, set
`deliver_artifacts:true`, and add Telegram to `delivery_channels` when
requested. Do not substitute raw content, merely mention that the artifact
exists, invent a download URL, or add a later notification node solely to send
the Decision's file. After updating a template, read it back and verify the
stored Decision contains the helper and delivery settings before claiming the
file will be shown or delivered.

## Gateways — pick the right kind, close what you open

- **Exclusive (XOR, default)** — exactly one outgoing path. Route with edge
  conditions + one `otherwise`, or `{mode:"ai"}` with named-`branch` edges (a
  judge agent picks ONE branch — AI mode is exclusive-only).
- **Parallel (AND)** — the fork takes ALL outgoing paths unconditionally (never
  put conditions on its edges). Every fork needs a converging gateway of the
  SAME kind to close it: the parallel join **accumulates** — it holds until
  every branch's token arrives, then continues once. Set `join_timeout` on the
  join to fail the run if a branch stalls.
- **Inclusive (OR)** — takes every path whose condition matches (give one edge
  `{"otherwise": true}` so at least one is taken). Close with an inclusive
  join — it waits only for the branches that were actually taken.
- **Aggregating branch results ("AI merge")** — a join only synchronizes; it
  does not combine data. To merge what the branches produced, put an
  `agent_task` right AFTER the join whose instruction reads each branch's
  namespaced output (`{{branchA.field}}`, `{{branchB.field}}`) and synthesizes
  the combined result — that step is your AI merge; downstream reads its output.

## Visual layout contract

The compiler owns exact BPMN coordinates, but node and edge order tell it which
grid to build. Author for a readable diagram, not merely a valid graph:

- Keep the normal forward path on one horizontal **main spine**: start, fork,
  join, synthesis, decision, approved work, and approved end should progress
  left to right.
- Treat every fork and matching same-kind join as one structured block. Put
  the fork first, then branch nodes in the desired **top-to-bottom order**, then
  the join. Keep both the fork's outgoing edges and the join's incoming edges
  in that same order.
- Put parallel branch steps in shared phase columns with even vertical spacing.
  Branches doing equivalent work should start at the same x-position and reach
  the join at the same x-position; avoid staggered boxes and diagonal crossing
  lines unless the branch truly has extra steps.
- Keep related decision exits in stable lanes. The approve path stays on the
  main spine; a direct deny/reject end uses one short outer exit lane; a refine
  edge returns to the proposal-producing step through its own outer return lane.
  Never weave a refine edge through downstream nodes or a parallel block.
- Give separate semantic exits separate nearby end nodes. Reusing a distant end
  across decisions creates long wires and an ambiguous diagram.
- Preserve this grid when updating a process: do not reorder unchanged
  branches, invert top/bottom lanes, or move a back-edge to the opposite side
  without a semantic reason.

After validation, treat every `LAYOUT_EDGE_*` warning as an authoring defect.
Reorder the affected nodes/edges or simplify the branch, validate again, and do
not call the process complete while layout warnings remain.

Before validation, verify the complete graph—not just its shape:

- `nodes` and `edges` are both inside the `graph` object.
- Every parallel research branch declares the structured field consumed later.
- The merge instruction explicitly interpolates every branch output.
- An agent-fed choice producer has no custom `output` schema; its decision uses
  `options_mode:"agent"` and `options_from`.
- Every requested decision outcome is present. A requested `refine` route goes
  directly back to the proposal-producing step; `deny` has a separate end.
- Every decision has non-empty `assignee_ids` or a complete function
  assignment (`mode:"function"` plus `function_id`).
- A PDF/output step consumes the decision's `selected_option` and the source
  options needed to resolve that value into full content. It declares
  `artifact_output:"pdf"`, `artifact_content_field` matching a non-empty
  structured text field, and an `artifact_name`; asking an agent for
  "PDF-ready Markdown" alone does not create or store an artifact.
- A decision that reviews that output embeds
  `{{artifact <pdf-step-id>}}`; do not paste the PDF's source content into the
  body.

## Patterns

- **AI triage** — an exclusive `gateway` with `{mode:"ai",prompt:"…"}` and named-`branch`
  edges; a judge agent routes.
- **Parallel work** — fork with `{kind:"parallel"}`, close with a `{kind:"parallel"}` join (+ `join_timeout`), then an AI-merge `agent_task` after the join when branch outputs need combining.

## Lifecycle

1. Read the guide, call `list_agents`, and read the current template (or list
   templates before creating a separate one).
2. `validate_process_graph` with the complete graph. Treat its response as a
   repair loop, not a report:
   - if `errors` or `warnings` are non-empty, map every message to the affected
     node or edge, fix the graph, and call `validate_process_graph` again;
   - repeat until `ready_to_save:true` **and** both `errors` and `warnings` are
     empty;
   - do not ask whether to fix a validation warning, summarize the process as
     complete, or move on to activation while any warning remains.
     MCP create/update also rejects warning-bearing graphs.
3. `create_process_template` with the validated graph (or
   `update_process_template`), then read it back with `get_process_template`.
4. `activate_process_template` only when the user explicitly asks; read it back
   before claiming it is active. `deactivate_process_template` pauses new runs.
5. `trigger_process_run` with `template_id` + optional `context_data` (becomes
   the `start` payload, available as `{{start.<field>}}`).
6. Operate the run:
   - `get_process_run` / `get_process_run_status` — status, current step,
     step logs. `list_process_runs` for history.
   - `list_process_tasks` / `get_process_task` — open human tasks;
     `update_process_task` then `complete_process_task` to push the run
     forward.
   - `submit_process_decision` (`run_id`, `step_id`, decision value matching a
     configured option) — resumes the engine and routes downstream edges by
     the chosen outcome.

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
- Give an `otherwise` branch to any gateway that can "fall through".
- **Call `list_agents` first** and use only ids it returns for
  `agent_employee_id` (agent tasks AND AI-judge gateways) — a stale/foreign id
  fails the step at runtime, and activation is refused for unresolvable agents.
- Reference only variables produced **upstream** of the node using them, and
  only **fields the step declares** (its `output` schema, or a decision's
  `resolution`/`selected_option`/`feedback`) — an undeclared field interpolates
  to an empty string.
- `validate_process_graph` returns non-blocking `warnings` (duplicate edges,
  unassigned decisions, missing deny routes, bad variable references, unknown
  agents) — treat them as authoring bugs. A task is finalized only after a
  fresh validation returns `ready_to_save:true` with no errors or warnings and
  the saved template has been read back.
- You never write BPMN XML, namespaces, or condition expressions — the
  compiler does. Author the graph; read it back with `get_process_template`
  (it returns the same graph).

## Tools Used

`list_agents`, `list_workspace_members`, `create_process_template`, `update_process_template`, `get_process_template`, `list_process_templates`, `delete_process_template`, `validate_process_graph`, `activate_process_template`, `deactivate_process_template`, `trigger_process_run`, `get_process_run`, `get_process_run_status`, `list_process_runs`, `list_process_tasks`, `get_process_task`, `update_process_task`, `complete_process_task`, `submit_process_decision`, `get_bpmn_authoring_guide`
