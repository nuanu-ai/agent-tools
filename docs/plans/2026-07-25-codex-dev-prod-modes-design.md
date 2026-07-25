# Codex Development and Production Modes

Date: 2026-07-25
Status: Design approved in conversation; written review pending

## Goal

Give Nuanu Flow plugin developers an explicit, low-friction way to:

- use the released Nuanu Flow plugin against `flow.nuanu.com`;
- develop and validate the same plugin against local Flow services;
- keep both installations and their authentication available across sessions;
- refresh local plugin changes without manual version editing; and
- validate the Codex worker against the same selected environment.

No Nuanu-specific CLI, global npm package, background daemon, or shell alias is
installed. The developer interface consists only of repository-local `npm run`
scripts and the already-installed Codex CLI.

## Non-goals

- Making production and development Flow tools active in the same Codex
  session.
- Replacing Codex's own login or credential storage.
- Persisting secrets in the repository, plugin manifest, or Codex profile
  files.
- Changing Claude Code's production plugin behavior.
- Building a general environment manager for services outside Nuanu Flow.

## Current Constraints

The production Codex plugin is `nuanu-flow@nuanu`. Its manifest embeds the
hosted MCP URL because Codex plugin manifests do not interpolate
`NUANU_MCP_URL`.

The current local installer temporarily changes the production manifest
version and replaces the `nuanu` marketplace registration with the local
checkout. As a result, the installed plugin still looks like production even
when it contains local code, and the remote production marketplace is no
longer independently available.

Codex persists plugin installation and enabled state under its normal config
home. Codex also persists its own login and MCP OAuth credentials. Named
profile files persist, but Codex 0.134 and later require the profile to be
selected for each new session with `--profile`.

The hosted Flow MCP endpoint is OAuth-ready in the plugin manifest but does not
currently expose the OAuth discovery metadata Codex requires. Production must
therefore retain environment-header authentication until server-side OAuth is
enabled.

## Chosen Architecture

### Two Stable Plugin Identities

Production remains unchanged:

| Property | Value |
| --- | --- |
| Marketplace | `nuanu` |
| Plugin | `nuanu-flow@nuanu` |
| Display name | `Nuanu Flow` |
| MCP server | `flow` |
| MCP URL | `https://flow.nuanu.com/mcp-server/mcp` |

Development is generated from the same source tree:

| Property | Value |
| --- | --- |
| Marketplace | `nuanu-dev` |
| Plugin | `nuanu-flow-dev@nuanu-dev` |
| Display name | `Nuanu Flow [DEV]` |
| MCP server | `flow_dev` |
| Default MCP URL | `http://localhost:3001/mcp` |

The separate identities isolate cache entries, skill prefixes, MCP tool
namespaces, enabled state, and MCP credentials. The development build is never
written back into `plugins/nuanu-flow`.

### Generated Development Marketplace

Repository-local scripts generate an ignored marketplace under:

```text
.build/codex-dev/
├── .agents/plugins/marketplace.json
├── state.json
└── plugins/nuanu-flow-dev/
```

The build copies the distributable plugin tree and transforms only the generated
Codex manifest:

- `name` becomes `nuanu-flow-dev`;
- `interface.displayName` becomes `Nuanu Flow [DEV]`;
- descriptions explicitly say `LOCAL DEVELOPMENT`;
- the MCP key becomes `flow_dev`;
- the MCP URL comes from `NUANU_DEV_MCP_URL`, defaulting to
  `http://localhost:3001/mcp`;
- environment headers use `NUANU_DEV_TOKEN`, `NUANU_DEV_AGENT_KEY`, and
  `NUANU_DEV_WORKSPACE`; and
- the version receives a Codex development cachebuster.

The generated marketplace display name is `Nuanu [DEV - local checkout]`.
Generated files are disposable and must not be committed.

### Persistent Profiles

The setup script owns two profile files:

```text
~/.codex/nuanu-flow-prod.config.toml
~/.codex/nuanu-flow-dev.config.toml
```

The production profile enables `nuanu-flow@nuanu` and disables
`nuanu-flow-dev@nuanu-dev`. The development profile does the reverse.

Each generated profile contains an ownership marker. Setup may update a file
with that marker, but refuses to overwrite an existing unowned file. Project
config and explicit CLI overrides retain their normal higher precedence.

Profiles do not duplicate Codex model, sandbox, approval, or user preferences.
They contain only the plugin enablement differences.

## Repository Command Surface

The root `package.json` exposes:

| Command | Behavior |
| --- | --- |
| `npm run codex:setup` | Register the remote production marketplace, generate/register the local development marketplace, install both plugins, and write the two owned profiles. |
| `npm run codex:dev` | Rebuild and reinstall the development plugin if its source fingerprint changed, run development preflight, print a development banner, and launch `codex --profile nuanu-flow-dev`. |
| `npm run codex:prod` | Run production preflight, print the production endpoint and installed version, and launch `codex --profile nuanu-flow-prod`. |
| `npm run codex:status` | Report marketplace sources, installed versions, source fingerprint, configured endpoints, profile state, endpoint health, and auth readiness without printing secrets. |
| `npm run codex:update` | Upgrade the remote `nuanu` marketplace and run `codex plugin add nuanu-flow@nuanu` so a newer production version is selected without removing auth state. |
| `npm run codex:refresh` | Force a new development cachebuster and reinstall even when the source fingerprint is unchanged. |
| `npm run codex:auth:prod` | Check production OAuth or capture a fallback production token into a supported secure store. |
| `npm run codex:auth:dev` | Check local OAuth or capture a distinct local development token into a supported secure store. |
| `npm run worker:dev` | Start the worker with local API/gateway defaults and the development Codex profile. |
| `npm run worker:prod` | Start the worker with hosted API/gateway defaults and the production Codex profile. |
| `npm run plugin:version -- patch` | Bump the canonical production manifest semver for a release. `minor`, `major`, and an explicit version are also accepted. |

All commands are implemented by Node scripts committed to this repository.
Nothing is linked or installed globally. Child Codex processes retain the
directory from which the npm command was invoked. An optional `--cwd` changes
the Codex working directory without changing the plugin source location.

## Authentication

Codex authentication and Nuanu Flow authentication remain separate.

### Codex Login

The scripts reuse the existing Codex login. They never copy or modify
`~/.codex/auth.json`.

### Production Flow

The preferred flow is one-time MCP OAuth:

```bash
codex mcp login flow
```

Codex persists those credentials in its configured MCP credential store and
reuses them in later sessions. Enabling OAuth discovery on the hosted MCP
server remains a server-side prerequisite.

Until then, production supports `NUANU_TOKEN` and `NUANU_AGENT_KEY` through the
existing environment-header mapping. On macOS, the auth script may persist a
fallback user token in Keychain using the built-in `security` command. On
other platforms, or when secure storage is unavailable, the script requires an
already-provided environment variable and reports that persistence is not
available. It never creates a plaintext repository credential file.

### Development Flow

Development uses separate variables:

- `NUANU_DEV_TOKEN`
- `NUANU_DEV_AGENT_KEY`
- `NUANU_DEV_WORKSPACE`

The launcher exports only the selected environment's values into the child
Codex process. A production token is never automatically reused against
localhost, and a development token is never forwarded to the hosted MCP
server.

### Worker Authentication

Workers continue to use `NUANU_AGENT_KEY`. Per-task short-lived agent keys
override the durable worker key inside the spawned Codex process. Development
worker scripts map `NUANU_DEV_AGENT_KEY` to `NUANU_AGENT_KEY` only for the
local worker child.

## Version and Refresh Model

The canonical production manifest uses normal semantic versions.

The development builder fingerprints all distributable files under
`plugins/nuanu-flow`, excluding generated output and test fixtures. When the
fingerprint changes, it generates:

```text
<base-version>+codex.local-<UTC timestamp>.<short fingerprint>
```

It then runs `codex plugin add nuanu-flow-dev@nuanu-dev`. It does not remove
the plugin first, preserving user-level plugin policy and credentials.

If the fingerprint is unchanged, `codex:dev` skips the build and reinstall.
`codex:refresh` bypasses that optimization.

Production launch never auto-upgrades. `codex:update` is explicit so a
developer does not receive new production plugin code while starting a normal
session.

## Mode Visibility and Safety

Development mode is visible in four independent places:

1. The terminal banner says `NUANU FLOW LOCAL DEVELOPMENT`.
2. The plugin display name is `Nuanu Flow [DEV]`.
3. Skills are prefixed with `nuanu-flow-dev:`.
4. MCP tools use the `flow_dev` server namespace.

The development preflight exits before launching Codex when the local MCP
endpoint is unavailable. It never falls back to production.

The production preflight reports `flow.nuanu.com`, the installed production
version, and auth readiness. It never falls back to localhost.

`codex:setup` detects the current unsafe state where marketplace `nuanu`
points at the local checkout. It reports the mismatch and repairs `nuanu` to
the Git-backed production source while preserving the distinct `nuanu-dev`
local marketplace.

## Worker Modes

`worker:dev` provides these defaults unless the caller overrides them:

```text
NUANU_URL=http://localhost:8000/api
NUANU_GATEWAY_URL=ws://localhost:3100/live/agent-gateway
NUANU_ADAPTER=codex-app-server
NUANU_CODEX_APP_SERVER_ARGS=--profile nuanu-flow-dev app-server --stdio
```

`worker:prod` uses:

```text
NUANU_URL=https://flow.nuanu.com/api
NUANU_ADAPTER=codex-app-server
NUANU_CODEX_APP_SERVER_ARGS=--profile nuanu-flow-prod app-server --stdio
```

The worker retains `codex-exec` as a one-shot fallback. App Server remains the
primary adapter for Nuanu's richer remote-worker integration because it exposes
thread lifecycle, streamed events, approvals, and structured output.

## Error Handling

- Missing or outdated Codex binary: fail with the detected path and the
  initially supported minimum, Codex CLI `0.145.0`.
- Local MCP or API unavailable: fail development preflight with the exact
  endpoint and expected service command.
- Missing auth: identify the selected mode and accepted credential sources
  without printing token prefixes.
- Marketplace name collision: refuse to replace a non-Nuanu marketplace.
- Unowned profile file: refuse to overwrite it and provide the exact conflicting
  path.
- Production marketplace registered as local: repair only when its source is
  this `agent-tools` checkout; otherwise stop and report the mismatch.
- Generated build interrupted: write into a temporary sibling directory and
  atomically rename it after validation.
- Plugin validation failure: retain the previous installed development build.

## Validation

### Automated Tests

Extend the zero-dependency Node test suite to cover:

- deterministic source fingerprinting;
- generated development manifest and marketplace shape;
- production source files remaining byte-identical after a development build;
- profile generation and ownership checks;
- safe marketplace migration;
- auth source selection without exposing secrets;
- version bump and cachebuster behavior;
- no-op development sync when the fingerprint is unchanged;
- forced refresh;
- command argument propagation into Codex and App Server;
- worker development and production environment mapping; and
- failure when a development command would contact a production endpoint.

CI validates both canonical production packaging and a generated development
package before running the full E2E suite.

### Real Acceptance Tests

Acceptance requires actual Codex processes, not only fake binaries:

1. Install both plugin variants into an isolated, unauthenticated test Codex
   home for plugin, profile, and MCP configuration checks.
2. Start a local MCP fixture and a local worker API fixture.
3. Launch a production-profile Codex process and verify only `flow` is enabled
   with the hosted URL.
4. Launch a development-profile Codex process and verify only `flow_dev` is
   enabled with the localhost URL.
5. In an explicit model-backed stage using the developer's normal authenticated
   Codex home, authenticate development, start a second fresh session, and
   verify the connection remains usable without reconfiguration.
6. Modify a copied skill, rerun development sync, and verify the installed
   development version and loaded skill content change.
7. Switch back to production and verify its configuration and auth readiness
   are unchanged.
8. Run a real local worker task through Codex App Server and verify completion
   is reported to the local API fixture.
9. Reject the run if any development process contacts `flow.nuanu.com`.

The model-backed stage snapshots the relevant plugin and marketplace state,
restores it in `finally`, and never copies Codex auth material. It requires an
existing Codex login and is exposed as an explicit local acceptance command.
CI continues to run deterministic protocol E2E tests without consuming model
credentials.

## Rollout

1. Add the builder, profile manager, status/preflight, auth helper, worker mode
   wrapper, version helper, and npm scripts.
2. Replace the existing production-overwriting local installer with the
   generated `nuanu-dev` flow.
3. Add migration logic for developers who already registered the checkout as
   marketplace `nuanu`.
4. Extend deterministic tests and GitHub Actions validation.
5. Run the real local acceptance suite against the local MCP and worker
   fixtures.
6. Update the root and plugin READMEs and the `codex-setup` skill.
7. Enable hosted MCP OAuth discovery separately; once verified, remove the
   transitional production token persistence guidance.

## Success Criteria

- No Nuanu-specific CLI or global package is installed.
- Production and development plugins remain installed simultaneously.
- Every session activates exactly one mode.
- Development mode is unmistakable to both the developer and Codex.
- Local changes become available after one repository-local command.
- New sessions reuse installed configuration and available authentication.
- Production updates are explicit and one command.
- Development cannot silently fall back to production.
- A real local Codex worker task passes end to end.
