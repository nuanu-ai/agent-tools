---
description: Launch this machine as a Nuanu Flow remote agent from just a worker token — resolves the API URL, starts the worker daemon, and confirms once the agent is connected
argument-hint: <worker-token> [api-url]
---

Launch the bundled remote-agent worker from a single worker token. This is the
zero-config path: the user pastes the token from the "Agent created" screen (or
the create form) and this command does the rest. Load the `remote-worker` skill
for protocol details if anything below is unclear.

Arguments: `$ARGUMENTS` — first word is the worker token (`nuanu_flow_…`, or a
legacy `plane_agent_…` key — both authenticate), optional second word is the
API base URL (ends with `/api`). If no token was given, ask the user for it.

1. **Resolve the API URL** (first match wins):
   - the second argument, if provided;
   - `$NUANU_URL` from the environment, if set;
   - otherwise probe candidates with the token and keep the first that
     answers — try `http://localhost:8000/api`, then `https://flow.nuanu.com/api`:
     ```bash
     curl -s -o /dev/null -w "%{http_code}" "<candidate>/agent-worker/whoami/" -H "X-Agent-Key: <token>"
     ```
     `200` → use it. If every candidate returns `401`, prefer one that is
     reachable at all: the token may simply not be active yet (the create form
     pregenerates tokens that go live on Create) — the worker retries, so
     proceed with the reachable candidate and tell the user to hit Create.
     If nothing is reachable, stop and ask the user for the URL.

2. **Identify the agent** (when whoami returned 200): report the agent's
   `display_name` and `workspace` from the whoami response, and abort with a
   clear message if `is_active` is false.

3. **Start the worker daemon in the background** (Bash with run_in_background),
   passing the resolved values explicitly so no prior exports are needed:

   ```bash
   NUANU_URL="<resolved-url>" NUANU_AGENT_KEY="<token>" node "${CLAUDE_PLUGIN_ROOT}/scripts/worker/worker.mjs"
   ```

   Respect any other worker env the user already exported (`NUANU_WORKER_ID`,
   `NUANU_ADAPTER`, `NUANU_MAX_CONCURRENCY`, `NUANU_TRANSPORT`,
   `NUANU_CLAUDE_SKIP_PERMISSIONS`, …). Defaults: poll transport, concurrency
   1, `claude` adapter.

4. **Confirm the connection**: watch the daemon's output for the line
   `remote agent connected — heartbeat OK` (first successful heartbeat; the
   daemon prints it within seconds once the token is live). Then tell the
   user, e.g.:

   > ✅ Remote agent connected: **<display_name>** (workspace `<workspace>`) —
   > polling for tasks. Assign this agent to an agent task in a process and
   > start a run; this session's worker will pick it up.

   If the log shows `fetch-and-lock unauthorized — token not active yet or
revoked` instead, the agent hasn't been created yet — say the worker is
   waiting and will connect automatically once they press Create.

5. **Tell the user how to stop it**: the background task can be killed from
   this session; the daemon drains gracefully on SIGINT/SIGTERM (finishes or
   requeues in-flight tasks within ~30 s).

Notes:

- Do NOT echo the full token back in your replies; refer to it by its prefix
  (first 16 characters).
- The daemon spawns `claude -p --output-format json` per task; the per-task
  `agent_key` is injected into the child env so the spawned session's Flow
  calls are attributed to the agent.
