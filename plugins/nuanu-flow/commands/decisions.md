---
description: Terminal decision inbox — list pending Nuanu Flow decisions and resolve them right here
---

Act as the user's Nuanu Flow decision inbox. Load the `bpmn-processes` skill
if you need protocol details.

1. **Find pending decisions**: `execute_tool("list_process_runs", {"status": "waiting"})`.
   For each waiting run, `execute_tool("get_process_run_status", {"run_id": …})`
   and keep the runs whose current step is a decision (step_type `decision`
   in the latest step log / current_step matches a decision node).

2. **Show the inbox** as a table: `| Run | Process | Decision | Waiting on | Since |`.
   Include each run's `Web:` link. If there are none, say the inbox is clear
   and stop.

3. **Fetch each decision's options** from its template:
   `execute_tool("get_process_template", {"template_id": …})` → find the graph
   node whose id equals the waiting step's id → `config.options`
   (value/label pairs) and `approval_mode`.

4. **Let the user decide**: for the decision the user picks (or one by one if
   few), present the options as a structured multiple-choice question (use
   your question tool — one option per configured value, plus "skip").
   Include the relevant context from the run (`context_data`, upstream step
   outputs in the step logs) so the user can decide without opening the app.

5. **Submit**: `execute_tool("submit_process_decision", {"run_id": …,
   "step_id": …, "decision": "<chosen value>"})`, then confirm what the run
   did next (re-fetch `get_process_run_status` — did it advance past the
   gate?) and print the run's web link.

Rules: never submit a decision the user did not explicitly pick; "skip"
means leave it pending. If a submission fails because someone else decided
first, refresh the inbox instead of retrying.
