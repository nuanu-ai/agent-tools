# Nuanu agent-tools

Public distribution of Nuanu's integrations for coding agents. Today that is
the **Claude Code plugin marketplace** for [Nuanu Flow](https://flow.nuanu.com)
— MCP tools, domain skills, and a remote agent worker runtime. Shells for other
agents (Codex CLI, Cursor) will live here alongside as they land.

## Install (Claude Code)

```
/plugin marketplace add nuanu-ai/agent-tools
/plugin install nuanu-flow@nuanu
```

Then run `/nuanu-flow:setup` inside Claude Code to verify auth and
connectivity. No configuration is required for the default browser-OAuth flow;
CI/scripted use can set `NUANU_TOKEN`, and remote agent workers set
`NUANU_URL` + `NUANU_AGENT_KEY` (see the plugin's README).

## What's inside

| Path | What |
| --- | --- |
| `plugins/nuanu-flow` | The Claude Code plugin: hosted MCP server config, 6 domain skills (work items, BPMN processes, artifacts, project setup, remote worker, orientation), slash commands, output style, and the zero-dependency worker daemon. |
| `.claude-plugin/marketplace.json` | The marketplace catalog (name `nuanu`). This repo owns it — edit it here. |

## Versioning

Plugins are versioned by commit SHA: every synced commit is a new version and
Claude Code picks it up on the next marketplace refresh. Content under
`plugins/` is mirrored from the source monorepo by CI — send issues and PRs
there when in doubt, or open them here and we'll route them.
