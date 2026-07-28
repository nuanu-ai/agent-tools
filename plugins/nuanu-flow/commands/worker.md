---
description: Start the Nuanu Flow remote-agent worker daemon (pulls BPMN agent tasks and executes them via Claude Code)
---

Start the bundled Nuanu Flow remote-agent worker. Load the `remote-worker`
skill for protocol details if anything below is unclear.

1. **Validate prerequisites** (fail fast with a clear message, do not start a
   broken daemon):
   - `NUANU_URL` set and ends with `/api`; `NUANU_AGENT_KEY` set
     (`nuanu_flow_…`). If either is missing, tell the user to run
     `/nuanu-flow:setup` first.
   - `node --version` ≥ 20.6 (the worker uses built-in fetch/WebSocket).
   - Verify the key:
     `curl -s "$NUANU_URL/agent-worker/whoami/" -H "X-Agent-Key: $NUANU_AGENT_KEY"`
     → report the agent's display name and workspace; abort on error or
     `is_active: false`.

2. **Start the daemon in the background** (Bash with run_in_background). Keep
   its output attached to this task; do not redirect it to a file:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worker/worker.mjs"
   ```

   Respect any worker env the user already exported (`NUANU_WORKER_ID`,
   `NUANU_MAX_CONCURRENCY`, `NUANU_ADAPTER`, `NUANU_TRANSPORT`,
   `NUANU_CLAUDE_SKIP_PERMISSIONS`, …). Defaults: poll transport, concurrency
   1, `claude` adapter.

3. **Confirm liveness**: within a few seconds the daemon logs its startup and
   first heartbeat. Report to the user: agent name, worker id, transport,
   concurrency, and that the platform dashboard (Workspace → Agents) should
   now show the agent as online. In Codex, when startup also reports
   `session_activity=attached`, explain that the live feed remains in the
   background task and significant updates will be summarized in this exact
   conversation on the user's next message. Do not promise a spontaneous chat
   message.

4. **Tell the user how to stop it**: the background task can be killed from
   this session, and the daemon drains gracefully on SIGINT/SIGTERM (finishes
   or requeues in-flight tasks within ~30 s).

Notes:

- The daemon spawns `claude -p --output-format json` per task and pipes the
  task prompt on stdin; the per-task `agent_key` is injected as
  `NUANU_AGENT_KEY` in the child env so the spawned session's Flow calls are
  attributed to the agent.
- Task failures are requeued automatically (up to 5 attempts) — transient
  errors need no operator action.
