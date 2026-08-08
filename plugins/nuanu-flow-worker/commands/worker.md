---
description: Start the Nuanu Flow remote-agent worker daemon and expose safe exact-session visibility
---

Start the bundled Nuanu Flow remote-agent worker. Load the `remote-worker`
skill for protocol details if anything below is unclear.

1. **Validate prerequisites** (fail fast with a clear message, do not start a
   broken daemon):
   - enrollment has stored a protected worker credential, or the advanced
     operator has supplied `NUANU_URL` and `NUANU_AGENT_KEY` explicitly;
   - `node --version` ≥ 20.6 (the worker uses built-in fetch/WebSocket).
   - resolve the enabled matching `nuanu-flow` companion through the host
     plugin registry, confirm `scripts/agent-bus/agent-bus.mjs` exists, and
     retain its exact absolute path. Never infer a sibling cache directory.

2. **Start the daemon in the background** (Bash with run_in_background):

   ```bash
   NUANU_AGENT_BUS_SCRIPT="<general-plugin-root>/scripts/agent-bus/agent-bus.mjs" \
     node "${CLAUDE_PLUGIN_ROOT}/scripts/worker/worker.mjs"
   ```

   Respect any worker env the user already exported (`NUANU_WORKER_ID`,
   `NUANU_MAX_CONCURRENCY`, `NUANU_ADAPTER`, `NUANU_TRANSPORT`,
   `NUANU_CLAUDE_SKIP_PERMISSIONS`, …). Defaults: poll transport, concurrency
   1, `claude` adapter.

3. **Confirm liveness**: within a few seconds the daemon logs its startup and
   first heartbeat. Report to the user: agent name, worker id, transport,
   concurrency, and that the platform dashboard (Workspace → Agents) should
   now show the agent as online.

4. **Tell the user how to stop it**: the background task can be killed from
   this session, and the daemon drains gracefully on SIGINT/SIGTERM (finishes
   or requeues in-flight tasks within ~30 s).

5. **Offer exact-session visibility**. In Codex,
   `/nuanu-flow-worker:peek` renders one read-only state snapshot and
   `/nuanu-flow-worker:babysit` follows sanitized
   milestones for the task owned by this exact conversation. Neither command
   calls Flow, mutates the task, or consumes next-prompt catch-up events.

6. **Offer sanitized diagnostics when debugging**. The worker keeps bounded,
   private task journals locally; Nuanu Flow receives only the current safe
   progress projection and compact terminal evidence. Read a task journal with:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worker/cli.mjs" logs --task "<task-id>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worker/cli.mjs" logs --task "<task-id>" --follow
   ```

   Add `--export "<new-path>"` to create a sanitized diagnostic bundle. The
   command refuses to overwrite an existing file and never retries, cancels,
   approves, resumes, or otherwise mutates the task.

Notes:

- Treat `remote agent connected — heartbeat OK` as worker readiness. Report
  `agent_bus=degraded` separately as reduced collaboration and allow task
  claims to continue while the bus is repaired.
- The daemon spawns `claude -p --output-format json` per task and pipes the
  task prompt on stdin; the per-task `agent_key` is injected as
  `NUANU_AGENT_KEY` in the child env so the spawned session's Flow calls are
  attributed to the agent.
- Task failures are requeued automatically (up to 5 attempts) — transient
  errors need no operator action.
- Worker journals contain only allowlisted operational phases and correlation
  fields. They never retain prompts, reasoning, response bodies, tool
  arguments, command lines, credentials, signed URLs, or file contents.
