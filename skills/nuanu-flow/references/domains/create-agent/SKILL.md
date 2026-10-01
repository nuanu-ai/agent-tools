---
name: create-agent
description: Design, create, edit, delete, connect, or launch a Nuanu Flow local or remote agent employee. Use for agent identity, prompt, model, skills, tools, integrations, MCP server connections and logins, task-scoped internal MCP, Process result contracts, least-privilege review, remote enrollment recovery, and current-session worker launch.
---

# Create a Nuanu Flow agent

Use this skill for the full agent lifecycle from a free-form brief to a
verified local agent or connected remote worker. Keep the interaction short:
reuse the conversation, ask at most one compact batch of missing questions,
and never ask again for facts the user already supplied.

A canonical operation name in this skill is guidance, not a current descriptor.
Summary candidates are not cacheable descriptors. Before direct execution, use
a matching cached full descriptor; otherwise make one `search_tools` lookup and
refine by canonical name or request `detail: "full"` to obtain the schema and
`schemaDigest`.

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

Call `execute_read_tool("get_agent_creation_options", {"workspace_slug":"..."})`
before naming a model, capability, skill, integration, MCP connection, or role. Its catalog
and URLs are authoritative for both localhost and production.

Do not invent identifiers. Do not attach an integration whose `connected`
value is false; explain what is missing and share `integrations_url`.
Attach only MCP connections whose `status` is `connected`; `configured`,
`auth_required`, and a completed OAuth redirect are not tool-readiness proof.

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

If the role is niche, regulated, or depends on current domain practice, use an
available web search/fetch tool to inspect a few primary sources and comparable
examples before drafting. Extract patterns and failure modes; do not copy an
example prompt. If search is unavailable, do not pretend it ran.

Present one compact agent card:

- display name and normalized handle;
- one-sentence description;
- runtime and role;
- local model, why it fits, and the main alternative considered;
- selected capability grants, skills, integrations, and MCP servers, each tied to a job;
- concise system prompt;
- three representative smoke tests.
- release choice: editable draft only, or create and publish immutable `v1`.

Start with no optional capabilities and add only those justified by a
representative job. Use exact `capabilities[].slug` values in `tools`; never
substitute provider names or model-facing function names. Explicit
“create/add this agent” wording authorizes the creation. Ask for confirmation
only when you inferred a material permission, external integration, or
different runtime.

Before presenting the card, perform a capability-fit pass against the exact
catalog returned by `get_agent_creation_options`:

1. Turn every representative job into concrete requirements: input modalities,
   output modalities, tool calling, structured output, context size, hosted
   capability slugs, external integrations/MCP tools, and instruction skills.
2. Remove every local model that lacks any required model capability. Treat
   reading an image as image input, not image generation; a text model cannot
   produce a valid PDF, image, audio, or other binary merely by naming that file
   type.
3. For each workflow dependency, select the exact available skill ID and attach
   it in `skills` for a **local** Agent. In particular, attach `artifacts` when a
   local Agent will publish durable Process outputs. A Nuanu-native remote worker
   gets the full bundled Nuanu Flow skill set from its installed `nuanu-flow`
   companion, including `artifacts`; its empty attached `skills` list is expected
   and is not a missing skill. A skill supplies operating instructions; it does
   not grant a missing executable capability.
4. Verify that every required integration and external MCP connection is
   connected and that every required hosted tool has an exact catalog slug.
5. If no catalog model/runtime satisfies the full job, do not create a
   misleading configuration. Narrow the output contract (for example,
   Markdown instead of PDF), choose a capable remote worker, or state the one
   missing dependency.

Include the resulting requirement-to-model/tool/skill mapping in the compact
agent card. Do not silently drop an unmet requirement.

When the Agent is being created for an existing Process step, read that bounded
step first with `get_process_graph({view:"selection",node_keys:[...]})`. Its
declared output—not a guessed filename or prompt—determines prerequisites. A
local step with any named Artifact output deterministically requires the exact
curated `artifacts` skill in the published Agent version. Capability labels and
`runtime_hints.required_worker_capabilities` remain informational.
A Nuanu-native remote step does not use that local attached-skill prerequisite:
its installed general plugin provides the full bundled skills. External A2A
Agents are separate and must be judged from their advertised Agent Card.

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
  "tools": ["<exact capability slug>"],
  "skills": ["<exact catalog id>"],
  "integrations": ["<connected catalog slug>"],
  "mcp_servers": ["<connected MCP connection id>"],
  "publish": true
})
```

Set `publish` to `false` only when the user wants a draft that cannot yet be
used by production Processes or schedules. Saving later edits updates the
draft only. Use `publish_agent_version` after explicit confirmation to create
an immutable version; use the returned `draft_content_hash` as the optimistic
publication boundary. A newer version affects new standalone work and future
`latest_published` schedule firings, but never silently upgrades an existing
thread, Process binding, running Process, or pinned schedule.

For a Nuanu-native remote worker, call:

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

Then call `execute_read_tool("list_agents", {"workspace_slug":"..."})` and verify
the exact ID, handle, runtime, role, active state, published/draft state, model,
tools, and `capabilities.skill_availability` against the approved capability-fit
mapping. For a local Agent, verify its attached skills. For a Nuanu-native remote
Agent, expect `source:"installed_plugin"`, `scope:"full_bundled"`, and
`includes_artifacts:true`; never treat its empty `capabilities.skills` list as a
missing Artifact skill.
Return the environment-aware `web_url`. Use `list_agent_versions` and
`get_agent_version` for version history or safe configuration inspection.
Restore copies a version into the draft; it never rewrites published history.

For an existing local Agent whose draft lacks a required curated skill, use
`patch_agent_draft` with its current `draft_content_hash` and a minimal
`add_curated_skill`/`remove_curated_skill` operation. This atomically changes the
draft only. Show the diff, obtain explicit publication confirmation, call
`publish_agent_version`, then bind the Process step to the returned exact
immutable version. Never mutate or silently reinterpret an old published
version.

For broader edits, call `update_agent`. Identity fields update immediately;
prompt, model, tools, skills, integrations, and external MCP connections update
only the editable draft and require the current `draft_content_hash` as
`expected_draft_hash`. Re-read with `list_agents`, review the changed draft,
and publish separately only after explicit approval. Never imply that a draft
edit changed the active immutable version.

Call `delete_agent` only after the user explicitly approves deletion. The tool
requires `confirm:true`; active Process-template references block deletion and
must be deactivated or rebound first. For Process runs, use
`cancel_process_run` for active execution and `delete_process_run` only for a
terminal run.

Never retrieve, request, print, or expose a durable `nuanu_flow_...` key.
Remote creation returns only a short-lived, single-use `nuanu_join_...`
enrollment in structured tool output.

For an externally hosted A2A agent, use the Remote Agent form in the agent
roster and select A2A. The current MCP catalog intentionally creates only local
agents and Nuanu-native remote workers; do not invent a `create_a2a_agent` tool.
The form pins the public Agent Card connection separately from Nuanu's canonical
ProcessItem v1 task/result contract.

## 5. Connect an MCP server to a local agent

Every local agent already receives Nuanu Flow's internal MCP through its own
role-scoped agent identity. Do not create or attach a workspace connection for
the internal MCP endpoint; `mcp_servers` is only for additional external tool
providers.

Use a workspace MCP connection when the local agent needs tools supplied by an
external MCP server. Keep three proofs separate:

1. **Configured:** endpoint, transport, and authentication method were saved.
2. **Authenticated:** bearer credentials exist or OAuth login completed.
3. **Connected:** the runtime reached the MCP transport and discovered tools.

Call `list_mcp_connections` first. For a no-auth server, call
`create_mcp_connection`, then `test_mcp_connection`. For a public OAuth client,
call `create_mcp_connection`, then `start_mcp_login`; give the returned consent
URL to the user and re-check with `list_mcp_connections` or
`test_mcp_connection` after they finish. Never ask the user to paste bearer
tokens, OAuth access/refresh tokens, or client secrets into chat. Secret-backed
connections must be completed in the Nuanu Flow agent UI.

Attach the returned connection ID in `mcp_servers` only after status is
`connected`. Publishing freezes the connection ID and public configuration
hash, never credentials. Token refresh does not require republishing; changing
the endpoint, transport, auth type, OAuth URLs, client ID, or scopes does.

Treat every newly attached MCP server as a high-risk capability expansion.
Tie it to a representative job, inspect the discovered tool names, and retain
normal approval boundaries for writes, messages, payments, deletion, or other
external effects.

## 6. Connect a Nuanu-native remote worker

If the user already said “run it here,” launch immediately. Otherwise ask one
short question:

> Remote agent created. Launch it in this Codex session, or give you the
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

## 7. Launch in the current Codex session

Use the paired plugins without restarting Codex:

1. Run `codex plugin list --available --json` and resolve both enabled plugins
   for the active environment: `nuanu-flow` plus `nuanu-flow-worker` (or both
   `-dev` identities). Use their exact reported install paths. Never guess a cache or build path,
   and never infer one plugin from the other's directory.
2. Run the worker plugin's `scripts/worker/enroll.mjs` as an attached process with
   `--base-url` set to structured `connection.api_url`.
3. Write only the enrollment token and a newline to that process's standard
   input. Do not put it in a command argument, URL, environment variable,
   temporary file, log, or assistant message.
4. Confirm the helper reports the expected agent and workspace.
5. Start the worker plugin's `scripts/worker/worker.mjs` in the background with
   `NUANU_ADAPTER=codex-app-server` and `NUANU_AGENT_BUS_SCRIPT` set to the
   exact general-plugin `scripts/agent-bus/agent-bus.mjs` path. The worker
   reads the protected credential written by enrollment.
6. Wait for `remote agent connected — heartbeat OK`, then return control to
   the user. Report Agent-bus readiness separately; `agent_bus=degraded` must
   not be described as worker-offline or block task claims. Report the agent,
   workspace, worker process/session ID, and how to stop it.

This worker is session-scoped. Keep it running in the background, and stop it
gracefully with SIGINT or SIGTERM when the user asks.

## 8. Put durable outputs on Process steps, not the agent profile

An Agent Employee defines reusable identity and capabilities. It does not own a
PDF, upload slot, attachment template, or output destination. When an agent must
produce a report, dataset, image, code snapshot, commit, pull request, or other
durable result, author an Agent Task in a Process and declare that step's data
schema plus Artifact output rules.

At execution time, local and worker-hosted agents always receive the internal
Nuanu Flow MCP under a short-lived task identity. A file-producing agent uses
Artifact MCP to create and version the file, then returns the exact Artifact and
ArtifactVersion IDs in its task result. A coding worker returns a commit
candidate that the server verifies against its admitted repository branch and
materializes as a `git.commit` Artifact. Never put bytes, signed URLs,
credentials, or a mutable "latest" Artifact in Process data.

Keep the declared file type inside the runtime's real capabilities. A local
text-only writing agent can publish Markdown with `text/markdown`; it cannot
produce a PDF merely by choosing a `.pdf` filename. Use `application/pdf` only
when a real PDF renderer or file-producing worker is attached and verified.

Keep these checks distinct:

1. the exact Agent Employee version contains required instruction skills and
   authorizes its relevant tools/connections;
2. the Process step declares each Artifact output by semantic name,
   description, kind, and optional MIME restrictions;
3. runtime completion resolves and verifies exact immutable versions;
4. Column Process Proof of Done separately decides whether those verified
   outputs satisfy the state-exit policy.

Load `bpmn-processes` to design or change this flow. Do not simulate Process
Artifact outputs by adding a PDF/file block to the agent settings panel.

## Tools Used

`execute_read_tool`, `execute_tool`, `get_agent_creation_options`, `create_local_agent`, `list_mcp_connections`,
`create_mcp_connection`, `test_mcp_connection`, `start_mcp_login`, `create_remote_agent`,
`prepare_remote_agent_connection`, `list_agents`, `list_agent_versions`,
`get_agent_version`, `update_agent`, `delete_agent`, `patch_agent_draft`,
`publish_agent_version`, `restore_agent_version`, `discard_agent_draft`,
`get_process_graph`, `cancel_process_run`, `delete_process_run`
