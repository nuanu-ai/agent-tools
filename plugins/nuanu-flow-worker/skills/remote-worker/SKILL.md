---
name: remote-worker
description: Connect a coding agent to Nuanu Flow as a remote agent worker — use the environment-aware one-prompt enrollment flow, or operate the worker REST protocol directly.
---

# Running as a remote agent worker

A Nuanu Flow **agent employee** with `runtime: "remote"` is executed by an
external worker instead of the platform's built-in agent runtime. The model is
**pull**: the worker dials out (NAT-proof, no inbound URL), identified by an
agent credential. When a process run reaches that agent's task, the engine parks the
step; the worker fetches it, does the work, and posts the result — which
advances the run exactly like a local agent would.

## Recommended creation and connection

For an agent-led flow, load `create-agent`. It discovers the active
environment, creates the remote agent through MCP, and either launches its
worker in the current Codex session or returns the environment-aware
connection prompt.

The UI remains available as an equivalent manual path: create a remote agent
and copy its generated prompt into Codex. Both paths point to the same guide:

- Local: `http://localhost:3000/connect/remote-agent.md`
- Production: `https://flow.nuanu.com/connect/remote-agent.md`

The guide installs or updates the matching `nuanu-flow` and
`nuanu-flow-worker` pair, exchanges the short-lived `nuanu_join_…` enrollment
token through standard input, stores the durable credential in OS-protected
storage, and launches this worker companion. Remote-agent mode does not start
human MCP OAuth or workspace onboarding. Never repeat or place the enrollment
token in a URL, command argument, environment variable, or file.

The installed general plugin is the native remote Agent's skill/MCP source:
every claimed task can use the full bundled Nuanu Flow skill set, including
`artifacts`, `bpmn-processes`, and `work-items`. `AgentEmployee.skills` is a
local-Agent version configuration surface and may be empty for a native remote
Agent. Never report a missing Artifact skill from that empty list. Host/model
capability labels still describe executable functionality and remain separate
from these instruction skills. Externally hosted A2A Agents are not covered by
this guarantee and expose only what their Agent Card advertises.

The enrollment prompt is the normal customer path. It does not expose a
durable agent key and is safe to retry on the same installation: the helper
verifies an already-enrolled credential without exchanging the token again.

## Manual operator prerequisites

1. A remote agent employee exists in the workspace (created through MCP or
   the app UI, with runtime "remote").
2. An **agent key** for it. Manual keys are minted once via the app or
   `POST /api/workspaces/<slug>/agent-employees/<agent_id>/keys/` — the
   plaintext `nuanu_flow_…` token is shown **only at creation**.
3. Env:

| Var                          | Meaning                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `NUANU_URL`                  | Django API base — **must include `/api`**, e.g. `https://flow.nuanu.com/api` or `http://localhost:8000/api` |
| `NUANU_AGENT_KEY`            | The durable `nuanu_flow_…` key                                                                              |
| `NUANU_WORKER_ID`            | Optional stable worker name (default `worker-<host>-<pid>`)                                                 |
| `NUANU_MAX_CONCURRENCY`      | Parallel tasks (default 1)                                                                                  |
| `NUANU_ADAPTER`              | `claude` (default) \| `codex` \| `command`                                                                  |
| `NUANU_TRANSPORT`            | `poll` (default) \| `gateway` (WS wake-ups)                                                                 |
| `NUANU_WORKER_CAPABILITIES`  | Optional comma-separated host-native semantic capabilities, such as `image_generation_v1`                   |
| `NUANU_BROWSER_QA`           | Set to `1` only when this host has a verified Playwright runtime                                            |
| `NUANU_QA_PLAYWRIGHT_MODULE` | Exact Playwright module path when it is not resolvable from the worker plugin                               |

## Start the companion daemon

After one-prompt enrollment, this plugin provides the zero-dependency worker
(Node ≥ 20.6) and reads the stored credential automatically. The paired
launcher resolves the exact general-plugin bus script path through the host
registry; never infer a sibling plugin cache path:

```bash
NUANU_ADAPTER=codex \
NUANU_AGENT_BUS_SCRIPT="<general-plugin-root>/scripts/agent-bus/agent-bus.mjs" \
node "<worker-plugin-root>/scripts/worker/worker.mjs"
```

Enrollment plus `remote agent connected — heartbeat OK` are the worker
readiness gate. `agent_bus=degraded` is a separate collaboration status: retry
or repair the general adapter, but do not mark the worker offline or prevent
task claims solely because transient messaging is unavailable.

The daemon heartbeats (~15 s), polls `fetch-and-lock`, and per task spawns the
adapter — the default `claude` adapter runs `claude -p --output-format json`,
pipes the task prompt on stdin, and exposes the task's **per-task
`agent_key`** as `NUANU_AGENT_KEY` in the child env, so the spawned session's
own Flow MCP calls are attributed to the agent. Results post back
automatically; SIGINT/SIGTERM drains gracefully.

For remote execution, the remote host owns its provider, model, tools, MCP
servers, and credentials. Nuanu Flow sends the resolved instruction, typed
inputs, output contract, platform authority, and required semantic capability
names; it does not install or project third-party generation infrastructure.
Configure and verify the generator on this host first, then opt in with, for
example, `NUANU_WORKER_CAPABILITIES=image_generation_v1`. App Server workers
advertise `artifact_media_constraints_v1` automatically because their
task-scoped publisher enforces the declared MIME allowlist; this does not imply
that an image generator is installed. Capability labels are informational:
the server records a safe claim warning when labels differ, but still delivers
the task. The worker and its agent remain responsible for reporting a real
execution failure if the requested work cannot be performed.

Browser QA is stricter because the worker provisions its browser before the
agent starts. With `NUANU_BROWSER_QA=1`, startup verifies Playwright before
advertising `browser_qa_v1`; install it on the host or provide the exact
`NUANU_QA_PLAYWRIGHT_MODULE` path. The worker does not download browsers or
guess another package's cache at task time.

## Inspect sanitized worker diagnostics

Detailed operational diagnostics stay on the worker instead of being mirrored
into every Nuanu Flow Agent Task event. The Process run shows the current safe
phase, freshness, worker/adapter identity, retry attempt, and compact terminal
evidence. On the worker host, use the vendored read-only CLI:

```bash
node "<worker-plugin-root>/scripts/worker/cli.mjs" logs
node "<worker-plugin-root>/scripts/worker/cli.mjs" logs --task "<task-id>"
node "<worker-plugin-root>/scripts/worker/cli.mjs" logs --task "<task-id>" --follow
node "<worker-plugin-root>/scripts/worker/cli.mjs" logs --task "<task-id>" --export "/new/safe-diagnostics.jsonl"
```

The journal is bounded to 200 sanitized records per task and expires after
seven days by default. It includes safe phases, provider/model identifiers,
retry and HTTP status, lease state, adapter session/turn identifiers, Artifact
categories, and terminal delivery. It excludes prompts, reasoning, response
bodies, tool arguments, command lines, credentials, signed URLs, paths, and
file contents. Reading or exporting logs never mutates the Agent Task.

During a claimed task, the worker passes only the short-lived per-task agent
credential to the spawned adapter. Human MCP OAuth and the worker credential
remain separate.

## The REST protocol (for self-polling without the daemon)

All endpoints authenticate with header **`X-Agent-Key: <key>`**.

| Method | Path                                      | Purpose                                                |
| ------ | ----------------------------------------- | ------------------------------------------------------ |
| POST   | `/agent-worker/tasks/fetch-and-lock/`     | Claim up to `max_tasks` pending tasks with a lease     |
| POST   | `/agent-worker/tasks/<task_id>/complete/` | Report the result; advances the run                    |
| POST   | `/agent-worker/tasks/<task_id>/fail/`     | Requeue (default) or give up                           |
| POST   | `/agent-worker/heartbeat/`                | Presence (drives the online/offline dashboard)         |
| POST   | `/agent-worker/ws-ticket/`                | Mint a 60 s single-use WebSocket ticket                |
| GET    | `/agent-worker/whoami/`                   | Resolve the key → agent identity (use to verify setup) |

**Claim**: `{"worker_id":"me-1","max_tasks":1,"lock_seconds":300}` → an array
of task envelopes:

- `task_id`, `run_id`, `step_id`, `step_name`, `workspace`, `thread_id`
- `contract_version` — always `nuanu.agent-task.v1`
- `request` — the immutable `nuanu.agent-task.request.v1` request containing
  exact Process/step/Agent-version identity, the resolved `instruction`, the
  predecessor `input` set, editable `output_definition`, authority grants, and
  informational `runtime_hints`
- `continuation_input` — explicit human responses received after admission
- `system_prompt` — the agent employee's configured system prompt
- `agent_key` — **short-lived per-task key (30 min)**: use it for any Flow
  API/MCP calls made _while doing the task_ so writes attribute to the agent
- `locked_until`, `lease_token`, `lease_generation` — the fenced lease

**Complete**: send `worker_id`, `lease_token`, and exactly one
`nuanu.agent-task.completion.v1` object under `completion`. A successful
completion contains `result.item` (`key`, `description`, `data`, and named
`artifacts`) plus `result.artifact_outputs`; a failure contains the closed
`error` object (`code`, `message`, `retryable`). The item key and shape must
match `request.process.step_key` and `request.output_definition`. Completing is
idempotent; if the run was cancelled meanwhile you get `{status:"ok",stale:true}`.

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
  # For each envelope, follow request.instruction using request.input, then POST
  # …/tasks/<task_id>/complete/ with worker_id, lease_token, and the exact
  # AgentTaskCompletionV1 object under completion.
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
