---
name: codex-remote-worker
description: Use when running Nuanu Flow remote agent tasks through Codex, validating App Server worker behavior, or choosing between production and local worker modes.
---

# Codex Remote Worker

Use this skill when a Nuanu Flow remote agent employee should be backed by a
Codex worker.

## Recommended worker mode

Use the repository wrapper so the worker and App Server select the same
production profile:

```bash
export NUANU_AGENT_KEY=nuanu_flow_...
npm run worker:prod
```

For local Flow development:

```bash
export NUANU_DEV_AGENT_KEY=nuanu_flow_...
npm run worker:dev
```

`codex-app-server` keeps the worker on Codex's App Server protocol instead of
shelling out to a one-shot CLI run. This is the best foundation when the
worker needs Codex harness behavior: thread lifecycle, streamed events,
approval handling, and future rich-client features.

## Fallback mode

For simple batch execution:

```bash
export NUANU_ADAPTER=codex-exec
```

`codex-exec` runs `codex exec` once per task and reads the final answer from
Codex's `--output-last-message` file.

## Important environment variables

| Variable | Meaning |
| --- | --- |
| `NUANU_URL` | Optional explicit worker API base, including `/api`. |
| `NUANU_AGENT_KEY` | Durable production remote-agent key. |
| `NUANU_DEV_AGENT_KEY` | Durable local development remote-agent key. |
| `NUANU_ADAPTER` | `codex-app-server` recommended, `codex-exec` fallback. |
| `NUANU_CODEX_BIN` | Codex binary, defaults to `codex`. |
| `NUANU_CODEX_CWD` | Working directory for task execution, defaults to the OS temp directory. |
| `NUANU_CODEX_APP_SERVER_ARGS` | Set by the wrapper to the selected profile before `app-server`. |
| `NUANU_CODEX_APP_SERVER_APPROVAL_MODE` | `deny` by default; set `approve` only in controlled environments. |

The worker exposes each task's short-lived `agent_key` as the selected
profile's agent-key variable inside Codex, so MCP/API writes made while doing
the task are attributed to the agent employee.

## Tools Used

Nuanu worker REST API, Codex App Server, Codex exec.
