---
description: Verify Nuanu Flow setup — auth mode, env vars, MCP connectivity, workspace access — and print exactly what's missing
---

Walk the user through verifying their Nuanu Flow plugin setup. Do each step,
then print one compact status report at the end.

**Auth modes** (detect from the env check in step 1 and tailor the report):

- **Ambient agent** — `NUANU_AGENT_KEY` is set (automatic inside worker-run
  sessions): MCP calls authenticate as the agent employee. Verify via step 3.
- **Manual token** — `NUANU_TOKEN` is set: acts as the user with a pasted
  API token (CI/scripts). Verify via step 2.
- **Proxy agent (default)** — neither is set: the hosted MCP server responds
  with an OAuth challenge and the browser opens Nuanu Flow to authorize;
  the user logs in there, picks a workspace, done. No env needed. If the
  connection shows as failed/expired, tell the user to run `/mcp` and
  re-authenticate the `flow` server.

1. **Check env vars** — run EXACTLY this snippet (POSIX-portable; do not
   rewrite it with shell-specific syntax like zsh `${(P)v}`, and never print
   full secret values):

   ```bash
   for v in NUANU_TOKEN NUANU_WORKSPACE NUANU_MCP_URL NUANU_URL NUANU_AGENT_KEY; do
     val=$(printenv "$v")
     if [ -n "$val" ]; then
       case "$v" in
         NUANU_TOKEN|NUANU_AGENT_KEY) echo "$v: set ($(printf '%.10s' "$val")...)" ;;
         *) echo "$v: set = $val" ;;
       esac
     else
       echo "$v: NOT SET"
     fi
   done
   ```

   Meaning of each:
   - `NUANU_TOKEN` — optional. Personal API token (`plane_api_…`) for manual
     mode; leave unset to use the browser OAuth flow instead.
   - `NUANU_AGENT_KEY` — ambient mode only (`nuanu_flow_…`); set
     automatically inside worker-run sessions.
   - `NUANU_WORKSPACE` — optional default workspace slug (OAuth users pick a
     workspace at consent; this env overrides it).
   - `NUANU_MCP_URL` — optional override; empty means the hosted server
     (`https://flow.nuanu.com/mcp-server/mcp`).

2. **Probe the MCP server**: call the `flow` MCP server's `execute_tool` with
   `{"name": "list_workspaces", "arguments": {}}`.
   - Success → list the workspace slugs returned and confirm whether
     `NUANU_WORKSPACE` is among them.
   - Auth error → the token is missing/invalid; point at step 1.
   - Connection error → the MCP URL is unreachable; if `NUANU_MCP_URL` is set
     to a localhost address, remind the user to start the local server
     (`pnpm --filter @plane/mcp dev:http`).

3. **Worker env (only if the user wants to run as a remote agent)**: check
   `NUANU_URL` (must end in `/api`) and `NUANU_AGENT_KEY` (`nuanu_flow_…`).
   If both set, verify with:
   `curl -s "$NUANU_URL/agent-worker/whoami/" -H "X-Agent-Key: $NUANU_AGENT_KEY"`
   and report the resolved agent name. If absent, note that `/nuanu-flow:worker`
   will need them and where to get a key (app → the remote agent's settings →
   keys; shown once at creation).

4. **Report**: a short checklist (✅/❌ per item) plus, for anything missing, a
   ready-to-paste `export NAME=…` snippet with placeholder values. Do not
   write to any shell profile or file — the user applies it themselves.
