---
name: codex-setup
description: Configure or diagnose the Nuanu Flow Codex plugin, select local development or production, and verify native MCP attachment without replacing existing authentication.
---

# Nuanu Flow in Codex

Read the installed plugin's `connection.json` to identify its environment.
Local development is `nuanu-flow-dev@nuanu-dev`, with loopback MCP and
`NUANU_DEV_*` variables. Production is `nuanu-flow@nuanu`, with the hosted MCP
and `NUANU_*` variables. Keep connections and authentication separate. Never
use a production token or connection as a fallback for unavailable localhost.
Installation before authentication cannot discover private workspace data.

Use Codex's native plugin directory and Connect/Authenticate controls. Preserve
an existing installation and working OAuth; do not uninstall, delete tokens,
edit host configuration, or repeat sign-in as a diagnostic step. Never print
tokens, callback codes, or credential files. A browser approval is not proof
of a completed callback or tool attachment.

For an explicitly requested local build, use Nuanu Flow's `pnpm plugin:build:local`.
This only generates `.build/plugins/local`; it does not install anything.
Select that local marketplace through the host's supported controls when the
user asks to install/test it. Production builds use `plugin:build:production`
and are published only through the existing authorized release process.
There is no staging build. Do not create an authentication wrapper or private
App Server call to work around missing host support.

After attachment, use a real read-only operation through the current native
MCP connection to verify it. If the active conversation cannot attach tools,
report that distinct host limitation; do not simulate tools in instructions
or silently start a child Codex process. Only explicit setup or a structured
`onboarding_required` response enters the `onboarding` skill. Preserve completed
setup and do not make an onboarding check on every startup.

For project-guided work, resolve the workspace and project after authentication,
then use the existing project binding and the project's current saved Flow.
A mode choice controls tracking, not a development methodology. Remote worker
execution is optional and belongs to the separate worker companion.

## Scoped local project context

The generated plugin includes `scripts/context/context.mjs`. It performs local
file I/O only and reads the bundle's registered `connection.json`; it never
authenticates or calls the network. Use it only after native MCP has returned a
fresh `principal_ref`, workspace, project, and complete `get_project.flow`.

Repository binding is explicit. Pipe a JSON object with
`binding:{workspace_slug,project_identifier}` to `context.mjs bind`. This writes
`.nuanu-flow.local.json` for the bundle's registered environment and adds that
file plus `.nuanu-flow-cache/` to the repository's local Git exclude. It never
edits shared instructions or a tracked ignore file. Local and production
bindings remain separate, and an invalid local binding blocks fallback.

After exhausting `list_projects` pagination and reading `get_project`, pipe a
sanitized snapshot to `context.mjs snapshot`: `principal` is the opaque
`principal_ref`; `session` is the host conversation ID; `workspace`, `project`,
`directory:{complete,projects}`, optional `active_item`/Artifact receipts, and
the current `effective_mode` are the only accepted context. Do not pass tokens,
prompts, source files, or arbitrary server responses. The cache retains the
full Flow description and exact columns under a connection-and-principal hash.

Session startup emits only a bounded pointer. A cached snapshot is never
authority: refresh identity and `get_project` before the first substantive
operation and every handoff. If the identity cannot be confirmed, ignore the
cache and continue with native MCP or fail open.

## Tools used

Native host plugin/MCP controls; `get_work_mode`, `list_workspaces`,
`list_projects`, `get_project`, and `onboarding_next` for explicit setup only.
