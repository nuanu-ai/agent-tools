# Nuanu Flow agent plugin

Use Nuanu Flow from Codex or Claude Code to manage Flow items, Memory, Wiki,
artifacts, and Processes through one MCP connection and focused domain skills.

## Install

Send this prompt to your coding agent:

```text
Read and install https://flow.nuanu.com/install.md
```

Follow the guide for your host and complete browser sign-in if requested. If
Nuanu Flow is already connected, keep that connection and continue below.
Completed onboarding does not need to run again.

## Verify with one read

Ask:

```text
Show the projects in my current Nuanu Flow workspace.
```

The agent should use the established workspace and call `list_projects`
through the attached read tool. A successful response, including an empty
list, verifies that read access works. It does not verify writes or a worker.
If no workspace is established, continue only the missing onboarding step.

## Try a task

- “Show the open risks in this project's Memory feed.”
- “Check what is missing before this Flow item can enter Build.”
- “Turn this confirmed Memory action into a Flow item.”

The `memory-feed` and `flows` skills guide these tasks. Availability follows
the connected server's catalog. Memory suggestions need human confirmation,
and Flow entry checks use the server's fixed rules.

## Other setup paths

For local development, use `Read and install http://localhost:3000/install.md`.
Keep localhost and production connections separate.

For remote execution, use the agent's generated connection prompt from
https://flow.nuanu.com/connect/remote-agent.md. It installs the separate
`nuanu-flow-worker` companion; ordinary plugin use needs only Nuanu Flow.

Host activation, manual authentication, repository bindings, portable skills,
and troubleshooting are in [advanced setup](https://github.com/nuanu-ai/agent-tools/blob/main/docs/nuanu-flow-setup.md).

## Host activation

Installation, authentication, and callable tools are separate checks. Preserve
an existing connection. Claude Code CLI can use `/reload-plugins`; hosts that
report `attachment: new_session_required` need a new session, while
`attachment: restart_required` means the CLI process must restart. Neither
state is proof that OAuth completed or that tools are attached. Prefer the
host's native plugin and MCP controls; do not launch another coding agent
just to repair the current conversation.

Run `onboarding_next` only for explicit setup, an explicit continuation, or a
structured `onboarding_required` response. Never repeat completed onboarding
merely because a plugin was loaded or a conversation resumed.
