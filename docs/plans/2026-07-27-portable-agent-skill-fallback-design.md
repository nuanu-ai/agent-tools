# Portable Nuanu Flow Agent Skill Fallback

Date: 2026-07-27
Status: Implemented and validated

## Goal

Make the Nuanu Flow operating logic available as one portable Agent Skill for
agents that cannot install the first-class Codex or Claude Code plugin.

The fallback must:

- install with one standard `npx skills add` command;
- include the same domain guidance used by the combined plugin;
- include a small, dependency-free remote-worker script;
- avoid plugin hooks, SessionStart behavior, native marketplace assumptions,
  and Codex/Claude-specific worker adapters;
- keep generated fallback content synchronized when canonical domain skills
  such as `bpmn-processes`, `work-items`, or `artifacts` change; and
- remain useful alongside the existing individually installable skills.

## Current State

`agent-tools` already exposes `skills/` at the repository root. The current
`skills` CLI discovers 12 valid skills, including `nuanu-flow`,
`bpmn-processes`, `work-items`, `artifacts`, onboarding/setup skills, and
agent/worker skills.

`scripts/sync-skills.mjs` currently copies
`plugins/nuanu-flow/skills/` byte-for-byte to `skills/`, and CI checks that
the trees match.

This supports:

```bash
npx skills add nuanu-ai/agent-tools
npx skills add nuanu-ai/agent-tools --skill nuanu-flow
```

but it has two important gaps:

1. Installing only `nuanu-flow` installs the router skill without the domain
   skills it tells the agent to load.
2. Installing all skills still does not include
   `plugins/nuanu-flow/scripts/worker/`, so the generic remote-worker guide
   points outside the installed skill.

No additional npm package or skills registry is required. The public Git
repository is already a supported source for the `skills` CLI.

## Standards and Constraints

The fallback follows the open Agent Skills specification:

- a directory with a required `SKILL.md`;
- lowercase, hyphenated `name` matching the directory;
- optional `scripts/`, `references/`, and `assets/`;
- relative file references from the skill root;
- progressive disclosure, with the main `SKILL.md` kept below 500 lines; and
- self-contained scripts with explicit dependencies and useful errors.

The `skills` CLI supports installing a single skill from a multi-skill Git
repository and targets Codex, Claude Code, and many other agents. It does not
define a portable MCP-registration format or portable lifecycle hooks.
Therefore:

- the fallback can teach an agent how to use an already connected Nuanu Flow
  MCP server;
- it can explain the agent's native MCP connection step when the harness
  supports remote HTTP MCP and OAuth;
- it must not pretend that installing a skill automatically registers or
  authenticates MCP on every agent; and
- remote-worker enrollment remains independent of interactive MCP OAuth.

## Chosen Distribution Model

Keep both existing distribution modes:

1. **Collection mode** — every canonical skill remains individually
   installable from `skills/<name>/`.
2. **Portable bundle mode** — `skills/nuanu-flow/` becomes a generated
   self-contained fallback bundle.

The recommended generic-agent command becomes:

```bash
npx skills add nuanu-ai/agent-tools --skill nuanu-flow
```

Users who want native discovery and activation of every domain skill can
still install the full collection:

```bash
npx skills add nuanu-ai/agent-tools --skill '*'
```

The Codex and Claude Code plugin remains the preferred path because it can
also provide native MCP configuration, OAuth, hooks, commands, and richer
worker adapters.

## Portable Bundle Layout

Generated output:

```text
skills/nuanu-flow/
├── SKILL.md
├── references/
│   ├── manifest.json
│   ├── artifacts.md
│   ├── bpmn-processes.md
│   ├── create-agent.md
│   ├── create-agent-design.md
│   ├── onboarding.md
│   ├── project-setup.md
│   ├── remote-worker.md
│   ├── work-items.md
│   ├── work-items-payloads.md
│   └── workspace-setup.md
└── scripts/
    └── worker.mjs
```

`SKILL.md` remains the compact router and orientation. Its generated fallback
section maps each supported intent to one direct reference file. When a peer
domain skill is installed, the agent may load that native skill; otherwise it
reads the bundled reference.

Domain references are generated from canonical files under
`plugins/nuanu-flow/skills/`. The compiler removes their YAML frontmatter,
preserves the instruction body, rewrites internal links, and flattens
one-level supporting references such as:

- `work-items/references/payloads.md` ->
  `references/work-items-payloads.md`;
- `create-agent/references/agent-design.md` ->
  `references/create-agent-design.md`.

`references/manifest.json` records the plugin version, source paths, SHA-256
hashes, and generated bundle hash. It contains no secrets or environment
state.

Agent-specific skills that exist only to operate the first-class plugin
(`codex-setup`, `codex-remote-worker`, and
`claude-code-remote-worker`) remain separately installable but are not copied
into the generic bundle. Their relevant environment-selection and safety
rules are summarized in the portable router and worker reference.

## Portable Worker

Add one zero-dependency Node script as the fallback runtime:

```text
plugins/nuanu-flow/scripts/worker/portable-worker.mjs
```

The build copies it to:

```text
skills/nuanu-flow/scripts/worker.mjs
```

It is deliberately smaller than the plugin worker:

- polling transport only; no WebSocket gateway;
- generic text-in/text-out command adapter only;
- no Codex App Server client;
- no Claude Code session management;
- no SessionStart or repository-context hooks;
- no plugin discovery or marketplace commands;
- no interactive user OAuth; and
- no runtime npm dependencies.

One file exposes three explicit subcommands:

```bash
node scripts/worker.mjs enroll --base-url https://flow.nuanu.com/api
node scripts/worker.mjs status
node scripts/worker.mjs run --command "<non-interactive command>"
```

### Enrollment and credentials

- `enroll` accepts a single `nuanu_join_...` token through standard input
  only.
- It exchanges the one-time token through the existing
  `/api/agent-worker/enroll/` contract.
- It writes the durable agent key to an XDG-compatible credential file with
  mode `0600`, never to the skill directory or project.
- Local and production credentials are keyed by normalized API origin.
- Output is redacted and contains only agent ID, display name, workspace, and
  environment.
- `NUANU_AGENT_KEY` remains an explicit ephemeral override for controlled
  environments; it is never printed.

### Runtime

- `run` requires an exact operator-supplied non-interactive command that reads
  a prompt on stdin and emits its final answer on stdout.
- It performs identity/heartbeat, `fetch-and-lock`, completion, and
  retry/requeue calls through the existing worker API.
- It defaults to one task at a time and uses bounded polling/backoff.
- It forwards `SIGINT`/`SIGTERM`, drains the current task for a bounded time,
  and exits non-zero on an unrecoverable authentication or configuration
  error.
- The durable key is used only for worker control-plane calls. Spawned model
  commands receive only the task-scoped key from the claimed task.
- Logs never contain enrollment tokens, durable keys, callback URLs, or raw
  authorization headers.

The portable worker is not a replacement for the plugin worker. Codex keeps
the App Server adapter and Claude Code keeps its native adapter through the
plugin.

## Deterministic Build

Replace the copy-only behavior in `scripts/sync-skills.mjs` with a compiler
that has two outputs:

1. copy every canonical plugin skill as an individually installable skill;
2. augment only the standalone `skills/nuanu-flow/` with generated domain
   references and the portable worker.

The combined plugin tree remains unmodified and does not contain duplicated
compiled references.

The compiler must:

1. Build into a temporary sibling directory.
2. Discover canonical skills from an explicit allowlist, not an unrestricted
   recursive copy.
3. Parse and validate each `SKILL.md` frontmatter.
4. Strip frontmatter from generated reference files.
5. Rewrite and validate every relative reference.
6. Copy `portable-worker.mjs` as `scripts/worker.mjs`.
7. Write `references/manifest.json` with stable, sorted JSON.
8. Compare generated bytes in `--check` mode.
9. Atomically replace `skills/` only after validation succeeds.

Keep the existing commands, but make their behavior compiler-backed:

```json
{
  "sync:skills": "node scripts/sync-skills.mjs",
  "check:skills": "node scripts/sync-skills.mjs --check"
}
```

No generated file should need a manual edit. A change to a canonical domain
skill must cause `check:skills` to fail until `sync:skills` regenerates the
fallback.

## Documentation

Update `README.md` and `plugins/nuanu-flow/README.md` to distinguish:

- plugin install for Codex/Claude Code;
- one-skill portable fallback for other agents;
- full Agent Skills collection install;
- MCP connection/authentication as a harness-specific capability; and
- portable remote-worker enrollment.

Document the simple fallback command first:

```bash
npx skills add nuanu-ai/agent-tools --skill nuanu-flow
```

Document `npx skills update nuanu-flow` for refreshes. Do not recommend
`npx skills use` for the worker because that command uses a temporary skill
directory and is not an appropriate home for a durable foreground worker.

## Implementation Plan

### 1. Lock the generated contract with failing tests

Extend `tests/e2e/agent-skills-e2e.test.mjs` to assert:

- the `skills` CLI discovers the current skill collection;
- installing only `nuanu-flow` into temporary Codex, Claude Code, and
  universal-agent homes includes `SKILL.md`, all generated references, and
  `scripts/worker.mjs`;
- no hooks, plugin manifests, MCP credential files, or unrelated worker
  adapters enter the fallback bundle;
- generated references match canonical source hashes; and
- all referenced files resolve within the skill root.

### 2. Implement the portable worker test-first

Add:

- `plugins/nuanu-flow/scripts/worker/portable-worker.mjs`;
- a fake worker API fixture; and
- `tests/e2e/portable-worker-e2e.test.mjs`.

Cover:

- token accepted only through stdin;
- enrollment and mode-`0600` storage;
- local/production origin separation;
- redacted status;
- identity and heartbeat;
- claim -> command stdin -> completion;
- command failure -> safe requeue;
- task-scoped credential isolation;
- bounded retry/backoff;
- expired/reused enrollment token errors; and
- graceful shutdown.

### 3. Turn skill sync into deterministic compilation

Update `scripts/sync-skills.mjs` to generate the portable bundle while
retaining individual skill copies. Add parser/link-rewrite tests and verify
that `--check` reports the exact stale source or generated file.

### 4. Add fallback routing to the standalone entry skill

Generate a concise section in standalone `nuanu-flow/SKILL.md` that:

- detects whether peer Nuanu skills are available;
- reads exactly one relevant bundled reference when they are not;
- explains that Agent Skills installation alone cannot universally register
  MCP;
- routes remote-agent enrollment to `scripts/worker.mjs`; and
- preserves local-versus-production environment boundaries.

Do not add this compiled fallback section to the plugin's canonical router.

### 5. Validate against the standards and real CLI

Run:

```bash
npm run sync:skills
npm run check:skills
npm run validate:plugins
npm test
npx skills add . --list
```

Use `skills-ref validate` against every generated skill directory. In
temporary homes, run real non-interactive installs for:

```bash
npx skills add . --skill nuanu-flow -a codex -y --copy
npx skills add . --skill nuanu-flow -a claude-code -y --copy
npx skills add . --skill nuanu-flow -a universal -y --copy
```

### 6. Run end-to-end remote-worker acceptance

Against the local Nuanu Flow stack:

1. Create a remote generic agent and issue an enrollment token.
2. Install only the portable `nuanu-flow` skill into a temporary agent home.
3. Enroll through stdin.
4. Start the portable worker with a deterministic fake text-in/text-out
   command.
5. Trigger a real process agent task.
6. Verify online presence, task claim, task-scoped credential use, output
   completion, and process-run advancement.
7. Revoke the agent credential and verify the worker stops rather than
   silently reconnecting with another environment.

No real user credentials or durable agent keys may appear in test logs or
fixtures.

### 7. Update CI and public instructions

Add the compiler check, Agent Skills validation, portable-worker tests, and
credential-free `npx skills` installation tests to
`.github/workflows/plugin-ci.yml`. Update both READMEs and the hosted generic
remote-agent guide to point at the installed skill worker rather than
requiring a full repository checkout.

## Acceptance Criteria

- One command installs a self-contained `nuanu-flow` fallback skill through
  the public Git repository.
- The installed skill works without plugin hooks or a plugin marketplace.
- BPMN, artifacts, work items, onboarding, workspace/project setup, and agent
  creation guidance are generated from the same canonical files as the
  plugin.
- Changing any bundled canonical skill makes `check:skills` fail until the
  bundle is regenerated.
- The fallback includes exactly one portable worker entry script.
- The portable worker enrolls without exposing tokens, stores credentials
  outside the project with mode `0600`, executes a real local worker task, and
  advances the process run.
- Codex and Claude Code plugin installs and their richer workers remain
  unchanged.
- Real `npx skills` list/install checks pass for Codex, Claude Code, and a
  generic/universal target.

## Risks and Mitigations

- **Duplicated instructions in a full-collection install:** the router prefers
  native peer skills and uses bundled references only as fallback.
- **Generated drift:** checked-in output, source hashes, `--check`, and CI make
  drift a build failure.
- **Broken nested references:** the compiler flattens and rewrites all
  one-level dependencies, then validates every link.
- **Credential leakage:** enrollment is stdin-only, credentials live outside
  the repository with mode `0600`, subprocesses receive task-scoped keys, and
  tests scan output for token prefixes.
- **Assuming portable MCP setup:** documentation explicitly separates skill
  installation from harness-native MCP registration and OAuth.
- **Worker becoming a second plugin runtime:** the fallback remains polling +
  command adapter only; richer adapters stay plugin-owned.

## Non-goals

- A universal cross-agent MCP installer.
- Portable lifecycle hooks or SessionStart behavior.
- Replacing the Codex or Claude Code plugin.
- Bundling Codex App Server or Claude Code adapters into the fallback.
- Publishing a separate npm package or Nuanu CLI.
- Automatically choosing or installing a third-party model command.

## Implementation outcome

Implemented on 2026-07-27 with the planned two-mode distribution:

- all 12 canonical plugin skills remain individually installable;
- `skills/nuanu-flow` is now a generated, self-contained fallback containing
  flattened domain references, `references/manifest.json`, and one
  zero-dependency `scripts/worker.mjs`;
- `scripts/sync-skills.mjs` builds through a temporary directory, validates
  the allowlisted source skills and relative links, records canonical hashes,
  and supports byte-for-byte `--check`;
- the portable worker implements stdin-only enrollment, origin-scoped private
  credentials, status, heartbeat, polling claim, a generic text-in/text-out
  command adapter, task-scoped credentials, completion/requeue, retries,
  redaction, and signal handling;
- the public install and remote-agent guides use the installed skill root for
  generic agents and no longer require a repository checkout; and
- CI validates the official Agent Skills format and performs real copied
  installs for Codex, Claude Code, and Universal.

Two implementation details were refined during acceptance:

1. The current official PyPI package exposes the reference validator as
   `uvx --from skills-ref agentskills validate`, so CI uses that command rather
   than assuming a `skills-ref` executable.
2. Live installation under macOS `/tmp` exposed the `/tmp` versus
   `/private/tmp` canonical-path alias. The worker now compares real paths
   before deciding whether to execute its CLI entry point, and the real-install
   acceptance test locks this behavior.

Validation completed:

```text
npm run check:skills                         passed (26 generated files)
npm run validate:skills:spec                passed (12 skills)
npm run validate:plugins                    passed
npm test                                    passed (67 tests)
npm run test:acceptance:skills              passed (Codex, Claude Code, Universal)
npm run test:acceptance:skills:live         passed
```

The live acceptance used the running local Flow API, engine, database, and
Celery worker. It installed only the portable skill, enrolled through stdin,
claimed and completed a real remote-agent process step, observed the process
run reach `completed`, revoked the durable key, verified subsequent status
failed closed, and removed the isolated workspace/user plus temporary
credential directory.
