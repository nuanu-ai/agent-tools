# Processes (BPMN workflows)

A **process** is an automated corporate workflow: humans, AI agents, and
decision gates advance a run step by step. You author a process as a
**structured graph** (nodes + edges) — **never raw BPMN XML**. The server
compiles the graph to BPMN and draws the diagram; invalid graphs return
structural errors to fix.

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

### Node types

| `type`         | What it does                                                                                                                                                                                                                                                                                                     | Key `config`                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`        | Entry point (exactly one).                                                                                                                                                                                                                                                                                       | `trigger`: `{mode:"manual"}` \| `{mode:"schedule",cron:"0 9 * * *"}` \| `{mode:"event",event:"issue_created"}`                                                                                                                                                    |
| `end`          | Terminates a branch (≥1).                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                 |
| `human_task`   | Pauses; creates a task a person must complete.                                                                                                                                                                                                                                                                   | `name`, `priority`, `assignee_ids:[…]`, `assign:{mode:"function",function_id,scope}`, `completion_requirements:[…]`                                                                                                                                               |
| `agent_task`   | Runs an AI agent, captures its output.                                                                                                                                                                                                                                                                           | `agent_employee_id`, `instruction` (Handlebars) — plus node-level `output:[{name,type}]` for structured fields                                                                                                                                                    |
| `decision`     | Pauses; asks a person to approve / deny / refine / pick an option; the choice routes the flow.                                                                                                                                                                                                                   | `title`, `description` (the question), `body` (the proposal, Handlebars), `approval_mode:"any"\|"consensus"`, `assign:{…}`; choices: `options_mode:"agent"` + `options_from:"<agentStepId>"` for agent-proposed rich options, or static `options:[{value,label}]` |
| `gateway`      | A branch/merge point. `kind` picks the semantics: `"exclusive"` (XOR, default — exactly ONE outgoing path, by conditions or an AI judge), `"parallel"` (AND — fork takes ALL paths; a same-kind join waits for all of them), `"inclusive"` (OR — every matching condition path; join waits for the active ones). | `kind:"exclusive"\|"parallel"\|"inclusive"`, `{mode:"simple"}` or `{mode:"ai",agent_employee_id,prompt}` (exclusive only), `join_timeout` on a converging gateway                                                                                                 |
| `notification` | Fire-and-forget message; does not wait.                                                                                                                                                                                                                                                                          | `message`, `recipient_ids:[…]`                                                                                                                                                                                                                                    |
| `webhook`      | Calls an external URL, waits for the response.                                                                                                                                                                                                                                                                   | `url`, `payload:{…}`                                                                                                                                                                                                                                              |

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
    { "id": "gate", "type": "gateway", "config": { "mode": "simple" } },
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
    { "from": "approve", "to": "gate" },
    { "from": "gate", "to": "fulfil", "when": { "outcome": "approve" } },
    { "from": "gate", "to": "end_no", "when": { "otherwise": true } },
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

**Agent-fed choices**: when an upstream agent produces the things being chosen
between, do NOT author static `options:[{value,label}]` (they render as bare
labels like "Option 1"). Set `options_mode:"agent"` +
`options_from:"<agentStepId>"` on the decision instead — the agent is asked to propose the options. The source step's reply shape is then FIXED to `{options, output}` — never declare an `output` schema on it (ignored; lint warns); need structured fields from the pick? Add a separate agent step after the decision. Each option renders with a full rich-text body in the
Decisions inbox. A pick approves the decision, so route forward on
`{"outcome":"approve"}` and read `{{<decisionId>.selected_option}}` downstream.

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

## Patterns

- **AI triage** — an exclusive `gateway` with `{mode:"ai",prompt:"…"}` and named-`branch`
  edges; a judge agent routes.
- **Parallel work** — fork with `{kind:"parallel"}`, close with a `{kind:"parallel"}` join (+ `join_timeout`), then an AI-merge `agent_task` after the join when branch outputs need combining.

## Lifecycle

1. `create_process_template` with a `graph` (or `update_process_template` to
   iterate). Invalid graphs return structural errors — fix and retry.
2. `validate_process_graph` to dry-run a graph without saving.
3. `activate_process_template` — a template must have a `start` and reachable
   `end`(s). `deactivate_process_template` to pause new runs.
4. `trigger_process_run` with `template_id` + optional `context_data` (becomes
   the `start` payload, available as `{{start.<field>}}`).
5. Operate the run:
   - `get_process_run` / `get_process_run_status` — status, current step,
     step logs. `list_process_runs` for history.
   - `list_process_tasks` / `get_process_task` — open human tasks;
     `update_process_task` then `complete_process_task` to push the run
     forward.
   - `submit_process_decision` (`run_id`, `step_id`, decision value matching a
     configured option) — resumes the engine and routes downstream edges by
     the chosen outcome.

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
  missing deny routes, bad variable references, unknown agents) — treat them
  as authoring bugs and fix before activating.
- You never write BPMN XML, namespaces, or condition expressions — the
  compiler does. Author the graph; read it back with `get_process_template`
  (it returns the same graph).

## Tools Used

`list_agents`, `create_process_template`, `update_process_template`, `get_process_template`, `list_process_templates`, `delete_process_template`, `validate_process_graph`, `activate_process_template`, `deactivate_process_template`, `trigger_process_run`, `get_process_run`, `get_process_run_status`, `list_process_runs`, `list_process_tasks`, `get_process_task`, `update_process_task`, `complete_process_task`, `submit_process_decision`, `get_bpmn_authoring_guide`
