---
name: codex-remote-worker
description: Use when running Nuanu Flow remote agent tasks through Codex, validating App Server worker behavior, or choosing between production and local worker modes.
---

# Codex Remote Worker

Use this skill when a Nuanu Flow remote agent employee should be backed by a
Codex worker.

## Recommended worker mode

When the user asks to design or create the agent, load `create-agent` first.
It can create the remote identity through MCP and launch the bundled worker in
this same Codex session without opening the agent form.

For a user-facing connection, follow the environment-matched copied prompt:

```text
Read and follow https://flow.nuanu.com/connect/remote-agent.md using enrollment token nuanu_join_…
```

Local development uses
`http://localhost:3000/connect/remote-agent.md`. Both guides install and
OAuth-authenticate the combined plugin if needed, exchange the short-lived
token through the bundled helper, keep the durable credential outside
model-visible output, and start the worker with the `codex-app-server`
adapter.

For repository development, use the wrappers so the worker and App Server
select the same isolated Codex home. These advanced wrappers intentionally
keep explicit `NUANU_AGENT_KEY` / `NUANU_DEV_AGENT_KEY` overrides.

For local Flow development:

```bash
export NUANU_DEV_AGENT_KEY=nuanu_flow_...
npm run worker:dev
```

`codex-app-server` keeps the worker on Codex's App Server protocol instead of
shelling out to a one-shot CLI run. This is the best foundation when the
worker needs Codex harness behavior: thread lifecycle, streamed events,
approval handling, and future rich-client features.

## Activity in the originating Codex session

Keep the worker as a background process attached to the task that launched it.
Its output is a safe live feed: connection changes, task start, category-level
tool progress, attention requests, completion, failure, and requeue. It never
prints assistant deltas, hidden reasoning, raw tool arguments, task
instructions, or credentials as activity.

Codex exposes the originating conversation as `CODEX_THREAD_ID`; the worker
inherits it and writes a bounded private activity inbox for only that session.
The plugin's `UserPromptSubmit` hook consumes significant unread events and
adds a short catch-up to the user's next turn, including the first prompt after
reopening Codex. Never guess the owner from the current directory or the most
recent session, and never broadcast activity to other Codex conversations.

The current Codex App uses a private stdio App Server connection. The worker
must not edit rollout files, resume the visible thread from its separate App
Server process, or promise spontaneous in-chat cards. A host-native live card
requires an explicit Codex plugin activity API.

## Fallback mode

For simple batch execution:

```bash
export NUANU_ADAPTER=codex-exec
```

`codex-exec` runs `codex exec` once per task and reads the final answer from
Codex's `--output-last-message` file.

## Important environment variables

| Variable                               | Meaning                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `NUANU_URL`                            | Optional worker API base including `/api`; production wrapper overrides must remain on `https://flow.nuanu.com`. |
| `NUANU_AGENT_KEY`                      | Durable production remote-agent key.                                                                             |
| `NUANU_DEV_AGENT_KEY`                  | Durable local development remote-agent key.                                                                      |
| `NUANU_ADAPTER`                        | `codex-app-server` recommended, `codex-exec` fallback.                                                           |
| `NUANU_CODEX_BIN`                      | Codex binary, defaults to `codex`.                                                                               |
| `NUANU_CODEX_CWD`                      | Working directory for task execution, defaults to the OS temp directory.                                         |
| `NUANU_CODEX_APP_SERVER_ARGS`          | App Server command, defaults to `app-server --stdio`.                                                            |
| `NUANU_CODEX_APP_SERVER_APPROVAL_MODE` | `deny` by default; set `approve` only in controlled environments.                                                |
| `NUANU_OWNER_SESSION_ID`               | Optional explicit owner override; Codex normally supplies `CODEX_THREAD_ID`.                                      |
| `NUANU_ACTIVITY_DATA_DIR`               | Optional private activity-inbox directory, mainly for isolated tests.                                             |

The worker exposes each task's short-lived `agent_key` as the selected
mode's agent-key variable inside Codex, so MCP/API writes made while doing the
task are attributed to the agent employee. `CODEX_HOME` selects the isolated
production or development plugin and MCP configuration. The Codex subprocess
receives only that task key; interactive tokens and the durable worker key are
removed from its environment.

## Tools Used

Nuanu worker REST API, Codex App Server, Codex exec.
