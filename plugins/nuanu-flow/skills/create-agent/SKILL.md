---
name: create-agent
description: Design, create, connect, or launch a Nuanu Flow local or remote agent employee from a brief. Use for agent identity, prompt, model, skills, tools, integrations, least-privilege review, remote enrollment recovery, and current-session worker launch.
---

# Create a Nuanu Flow agent

Use this skill for the full agent lifecycle from a free-form brief to a
verified local agent or connected remote worker. Keep the interaction short:
reuse the conversation, ask at most one compact batch of missing questions,
and never ask again for facts the user already supplied.

## 1. Check that an agent is the right object

- Use an **agent** for work that needs judgment, tool choice, or adaptation to
  incomplete context.
- Use a **Process** for a repeatable sequence, schedule, event trigger,
  approval path, or deterministic hand-off.
- Use ordinary automation for one fixed action.

If the brief is mainly deterministic, recommend a Process in one sentence.
Continue with an agent when the user explicitly wants one. Load
`bpmn-processes` instead when they choose a Process.

## 2. Discover the active environment

Call `execute_tool("get_agent_creation_options", {"workspace_slug":"..."})`
before naming a model, skill, integration, or role. Its catalog and URLs are
authoritative for both localhost and production.

Do not invent identifiers. Do not attach an integration whose `connected`
value is false; explain what is missing and share `integrations_url`.

## 3. Build the smallest effective brief

Extract these from the conversation and ask only for material gaps:

- purpose and two or three representative jobs;
- expected output and success criteria;
- boundaries, escalation conditions, and prohibited actions;
- required knowledge and capabilities;
- local or remote runtime, only when it cannot be inferred.

Default to `member`. Use `guest` for narrowly read-only work and `admin` only
when the user explicitly requires workspace administration.

For detailed prompt, model, capability, and evaluation guidance, read
`references/agent-design.md`.

Present one compact agent card:

- display name and normalized handle;
- one-sentence description;
- runtime and role;
- local model;
- selected skills, tools, and integrations;
- concise system prompt;
- three representative smoke tests.

Start with no optional capabilities and add only those justified by a
representative job. Explicit “create/add this agent” wording authorizes the
creation. Ask for confirmation only when you inferred a material permission,
external integration, or different runtime.

## 4. Create and verify

For a local runtime, call:

```text
execute_tool("create_local_agent", {
  "workspace_slug": "...",
  "display_name": "...",
  "name": "...",
  "description": "...",
  "role": "member",
  "base_model": "<exact catalog id>",
  "system_prompt": "...",
  "tools": [],
  "skills": ["<exact catalog id>"],
  "integrations": ["<connected catalog slug>"]
})
```

For a remote runtime, call:

```text
execute_tool("create_remote_agent", {
  "workspace_slug": "...",
  "display_name": "...",
  "name": "...",
  "description": "...",
  "role": "member",
  "system_prompt": "..."
})
```

Then call `execute_tool("list_agents", {"workspace_slug":"..."})` and verify
the exact ID, handle, runtime, role, and active state. Return the environment-
aware `web_url`.

Never retrieve, request, print, or expose a durable `nuanu_flow_...` key.
Remote creation returns only a short-lived, single-use `nuanu_join_...`
enrollment in structured tool output.

## 5. Connect a remote agent

If the user already said “run it here,” launch immediately using the current
harness. Otherwise ask one short question:

> Remote agent created. Launch it in this session, or give you the
> connection prompt for another machine?

For another machine, return the structured `connection.connection_prompt`
without reformatting its URL or token. Tell the user the handoff expires at
`connection.expires_at`.

For a lost or expired handoff, first obtain explicit reconnect intent, then
call:

```text
execute_tool("prepare_remote_agent_connection", {
  "workspace_slug": "...",
  "agent_id": "..."
})
```

This revokes any prior unused enrollment. Never rotate it implicitly.

## 6. Launch in the current session

Use the bundled scripts without restarting Codex:

1. Resolve the active plugin root from the loaded skill path (`../..`). If the
   skill is not filesystem-backed, use the current harness's plugin inventory:
   `codex plugin list --json` for Codex or `claude plugin list --json` for
   Claude Code. Select the enabled Nuanu Flow plugin for the active environment
   and use its exact installed path. Never guess a cache or build path.
2. Run the plugin's `scripts/worker/enroll.mjs` as an attached process with
   `--base-url` set to structured `connection.api_url`.
3. Write only the enrollment token and a newline to that process's standard
   input. Do not put it in a command argument, URL, environment variable,
   temporary file, log, or assistant message.
4. Confirm the helper reports the expected agent and workspace.
5. Start `scripts/worker/worker.mjs` in the background with
   `NUANU_ADAPTER=codex-app-server` in Codex or
   `NUANU_ADAPTER=claude-code` in Claude Code. For another harness, ask for its
   text-in/text-out command and use the generic command adapter. The worker
   reads the protected credential written by enrollment.
6. Wait only for `remote agent connected — heartbeat OK`, then return control
   to the user. Report the agent, workspace, worker process/session ID, and
   how to stop it.

This worker is session-scoped. Keep it running in the background, and stop it
gracefully with SIGINT or SIGTERM when the user asks.

## Tools Used

`get_agent_creation_options`, `create_local_agent`, `create_remote_agent`,
`prepare_remote_agent_connection`, `list_agents`
