---
name: remote-worker
description: Connect a coding agent to Nuanu Flow as a remote agent worker — authenticate with an agent key, pull BPMN agent tasks (fetch-and-lock), execute them, and report complete/fail; via the bundled zero-dependency daemon or direct REST calls.
---

# Running as a remote agent worker

A Nuanu Flow **agent employee** with `runtime: "remote"` is executed by an
external worker instead of the platform's built-in agent runtime. The model is
**pull**: the worker dials out (NAT-proof, no inbound URL), identified by an
agent key. When a process run reaches that agent's task, the engine parks the
step; the worker fetches it, does the work, and posts the result — which
advances the run exactly like a local agent would.

## Prerequisites

1. A remote agent employee exists in the workspace (created in the app UI,
   with runtime "remote").
2. An **agent key** for it. Keys are minted once via the app or
   `POST /api/workspaces/<slug>/agent-employees/<agent_id>/keys/` — the
   plaintext `plane_agent_…` token is shown **only at creation**.
3. Env:

| Var | Meaning |
|---|---|
| `NUANU_URL` | Django API base — **must include `/api`**, e.g. `https://flow.nuanu.com/api` or `http://localhost:8000/api` |
| `NUANU_AGENT_KEY` | The durable `plane_agent_…` key |
| `NUANU_WORKER_ID` | Optional stable worker name (default `worker-<host>-<pid>`) |
| `NUANU_MAX_CONCURRENCY` | Parallel tasks (default 1) |
| `NUANU_ADAPTER` | `claude` (default) \| `codex` \| `command` |
| `NUANU_TRANSPORT` | `poll` (default) \| `gateway` (WS wake-ups) |

## Quick start — the bundled daemon

The plugin vendors the zero-dependency worker (Node ≥ 20.6):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/worker/worker.mjs
# or interactively: /nuanu-flow:worker
```

The daemon heartbeats (~15 s), polls `fetch-and-lock`, and per task spawns the
adapter — the default `claude` adapter runs `claude -p --output-format json`,
pipes the task prompt on stdin, and exposes the task's **per-task
`agent_key`** as `NUANU_AGENT_KEY` in the child env, so the spawned session's
own Flow MCP calls are attributed to the agent. Results post back
automatically; SIGINT/SIGTERM drains gracefully.

Because the plugin's MCP config forwards `NUANU_AGENT_KEY` as `X-Agent-Key`,
a worker-spawned Claude session with this plugin installed is **already
authenticated as the ambient agent** — no OAuth prompt, no setup inside task
executions.

## The REST protocol (for self-polling without the daemon)

All endpoints authenticate with header **`X-Agent-Key: <key>`**.

| Method | Path | Purpose |
|---|---|---|
| POST | `/agent-worker/tasks/fetch-and-lock/` | Claim up to `max_tasks` pending tasks with a lease |
| POST | `/agent-worker/tasks/<task_id>/complete/` | Report the result; advances the run |
| POST | `/agent-worker/tasks/<task_id>/fail/` | Requeue (default) or give up |
| POST | `/agent-worker/heartbeat/` | Presence (drives the online/offline dashboard) |
| POST | `/agent-worker/ws-ticket/` | Mint a 60 s single-use WebSocket ticket |
| GET | `/agent-worker/whoami/` | Resolve the key → agent identity (use to verify setup) |

**Claim**: `{"worker_id":"me-1","max_tasks":1,"lock_seconds":300}` → an array
of task envelopes:

- `task_id`, `run_id`, `step_id`, `step_name`, `workspace`, `thread_id`
- `instruction` — the prompt (Handlebars already resolved)
- `context` — upstream step outputs and run variables
- `output_schema` — when present, return **only** a JSON object matching it
- `options_request` — when present, the task wants decision options proposed
- `system_prompt` — the agent employee's configured system prompt
- `agent_key` — **short-lived per-task key (30 min)**: use it for any Flow
  API/MCP calls made *while doing the task* so writes attribute to the agent
- `locked_until` — your lease deadline

**Complete**: `{"worker_id":"me-1","status":"ok","output":…}` (or
`{"status":"error","error":"…"}` to fail the step). Completing is
**idempotent**; if the run was cancelled meanwhile you get
`{status:"ok", stale:true}`.

**Fail**: `{"worker_id":"me-1","error":"…","requeue":true}` — requeues up to
5 total attempts, then the step errors.

**Lease rules**: a lease expires at `locked_until` and becomes reclaimable by
anyone; `complete`/`fail` from a different `worker_id` than the lease holder
returns **409** `{held_by: …}` — treat it as "someone else took over, drop the
task".

### Minimal self-poll loop

```bash
while true; do
  TASKS=$(curl -s -X POST "$NUANU_URL/agent-worker/tasks/fetch-and-lock/" \
    -H "X-Agent-Key: $NUANU_AGENT_KEY" -H "Content-Type: application/json" \
    -d '{"worker_id":"self-poll-1","max_tasks":1,"lock_seconds":600}')
  # for each envelope: do the work per instruction/context/output_schema, then
  # POST …/tasks/<task_id>/complete/ with {"worker_id":"self-poll-1","status":"ok","output":…}
  curl -s -X POST "$NUANU_URL/agent-worker/heartbeat/" \
    -H "X-Agent-Key: $NUANU_AGENT_KEY" -d '{"worker_id":"self-poll-1"}'
  sleep 5
done
```

### Optional: WebSocket wake-ups instead of polling

`POST /agent-worker/ws-ticket/` → `{ticket}` → connect
`wss://<live-host>/live/agent-gateway?ticket=<ticket>` (tickets are
single-use, 60 s). On any `{type:"task"}` message, call `fetch-and-lock` over
HTTP — the socket only wakes you, it never carries payloads. Durable keys are
rejected on the socket; always use a ticket.

## Tools Used

None — this skill drives the worker REST API directly (X-Agent-Key auth).
While executing a claimed task, use the other skills (work-items, artifacts,
bpmn-processes) with the per-task agent_key.
