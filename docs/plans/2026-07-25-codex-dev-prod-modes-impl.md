# Codex Development and Production Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, clearly separated production and local-development Codex plugin modes using only repository-local npm scripts and the existing Codex installation.

**Architecture:** Keep `nuanu-flow@nuanu` as the immutable production identity and generate `nuanu-flow-dev@nuanu-dev` into an ignored build directory. Persistent Codex profile files select exactly one identity per session, while focused repository scripts handle packaging, setup, authentication, status, launch, worker propagation, and updates.

**Tech Stack:** Node.js 22 standard library, Codex CLI 0.145.0 or newer, `node:test`, JSON manifests, TOML profile text, GitHub Actions.

## Global Constraints

- Do not install a Nuanu CLI, global npm package, daemon, or shell alias.
- Do not add runtime npm dependencies.
- Do not mutate `plugins/nuanu-flow/.codex-plugin/plugin.json` during development builds.
- Keep `nuanu-flow@nuanu` pointed at `https://flow.nuanu.com/mcp-server/mcp`.
- Generate development artifacts only under `.build/codex-dev/`.
- Use `nuanu-flow-dev@nuanu-dev`, MCP server `flow_dev`, and display name `Nuanu Flow [DEV]`.
- Default development endpoints are `http://localhost:3001/mcp`, `http://localhost:8000/api`, and `ws://localhost:3100/live/agent-gateway`.
- Use separate development auth variables: `NUANU_DEV_TOKEN`, `NUANU_DEV_AGENT_KEY`, and `NUANU_DEV_WORKSPACE`.
- Never print, commit, or write secrets into plugin manifests or Codex profile files.
- Require Codex CLI 0.145.0 or newer.
- Preserve unrelated dirty worktree changes.

---

## File Map

### New files

- `scripts/codex/modes.mjs`: shared constants, path resolution, version checks, process execution, safe JSON reads, and mode-specific environment mapping.
- `scripts/codex/dev-package.mjs`: source fingerprinting and atomic generation of the `nuanu-dev` marketplace and `nuanu-flow-dev` plugin.
- `scripts/codex/setup.mjs`: marketplace registration, plugin installation, owned profile generation, and migration from the old local `nuanu` registration.
- `scripts/codex/auth.mjs`: OAuth readiness and macOS Keychain/environment fallback for mode-specific Flow credentials.
- `scripts/codex/status.mjs`: read-only report of Codex version, marketplaces, plugins, profiles, endpoints, and auth readiness.
- `scripts/codex/run-mode.mjs`: development/production preflight and interactive Codex launch.
- `scripts/codex/run-worker.mjs`: development/production worker environment mapping and foreground worker launch.
- `scripts/codex/update.mjs`: explicit production marketplace/plugin refresh.
- `scripts/codex/version.mjs`: canonical production manifest semver bump.
- `tests/fixtures/fake-codex.mjs`: stateful fake Codex executable for deterministic command, profile, marketplace, and plugin tests.
- `tests/e2e/codex-dev-modes-e2e.test.mjs`: deterministic package, profile, setup, auth, status, launch, update, and version tests.
- `tests/acceptance/codex-dev-modes-acceptance.mjs`: opt-in real Codex and App Server acceptance suite.
- `.gitignore`: ignores `.build/`.

### Modified files

- `scripts/codex/dev-install.mjs`: compatibility shim that delegates to the new development sync path without replacing marketplace `nuanu`.
- `scripts/codex/auth-doctor.mjs`: reuse shared endpoint/auth classification and support explicit mode output.
- `scripts/validate-plugins.mjs`: validate an optional generated Codex plugin and marketplace root.
- `package.json`: expose repository-local setup, mode, auth, worker, update, version, validation, and acceptance scripts.
- `tests/e2e/codex-plugin-e2e.test.mjs`: replace old production-overwriting installer assertions with generated-development-package assertions.
- `tests/e2e/worker-e2e.test.mjs`: assert profile argument propagation and environment isolation.
- `.github/workflows/plugin-ci.yml`: build and validate the generated development package.
- `README.md`: document the no-install production/development workflow.
- `plugins/nuanu-flow/README.md`: document mode-specific auth, endpoints, workers, and updates.
- `plugins/nuanu-flow/skills/codex-setup/SKILL.md`: teach Codex the new repository-local workflow.

---

### Task 1: Shared Mode Model and Development Package

**Files:**
- Create: `scripts/codex/modes.mjs`
- Create: `scripts/codex/dev-package.mjs`
- Create: `.gitignore`
- Create: `tests/e2e/codex-dev-modes-e2e.test.mjs`
- Modify: `scripts/codex/dev-install.mjs`

**Interfaces:**
- Produces: `modeConfig(name, env) -> ModeConfig`
- Produces: `runCodex(args, options) -> SpawnSyncResult`
- Produces: `assertCodexVersion(versionText, minimum) -> void`
- Produces: `fingerprintPlugin(pluginRoot) -> Promise<string>`
- Produces: `buildDevPackage(options) -> Promise<{changed, fingerprint, version, marketplaceRoot, pluginRoot}>`
- Consumes: canonical plugin at `plugins/nuanu-flow`

- [ ] **Step 1: Write failing tests for constants, fingerprinting, and generated output**

Add tests that import the new modules and assert:

```js
const dev = modeConfig("dev", {
  NUANU_DEV_MCP_URL: "http://127.0.0.1:4321/mcp",
});
assert.equal(dev.pluginId, "nuanu-flow-dev@nuanu-dev");
assert.equal(dev.mcpName, "flow_dev");
assert.equal(dev.mcpUrl, "http://127.0.0.1:4321/mcp");
assert.equal(dev.tokenEnv, "NUANU_DEV_TOKEN");

const prod = modeConfig("prod", {});
assert.equal(prod.pluginId, "nuanu-flow@nuanu");
assert.equal(prod.mcpUrl, "https://flow.nuanu.com/mcp-server/mcp");
assert.equal(prod.tokenEnv, "NUANU_TOKEN");
```

Build into a temporary directory with a fixed clock and assert that:

```js
assert.equal(result.changed, true);
assert.match(result.version, /^0\.1\.0\+codex\.local-20260725-120000\.[a-f0-9]{12}$/);
assert.equal(devManifest.name, "nuanu-flow-dev");
assert.equal(devManifest.interface.displayName, "Nuanu Flow [DEV]");
assert.equal(devManifest.mcpServers.flow_dev.url, "http://localhost:3001/mcp");
assert.equal(
  devManifest.mcpServers.flow_dev.env_http_headers["X-Plane-User-Token"],
  "NUANU_DEV_TOKEN",
);
assert.equal(await fs.readFile(prodManifestPath, "utf8"), originalProdManifest);
```

Run: `node --test tests/e2e/codex-dev-modes-e2e.test.mjs`

Expected: FAIL because `modes.mjs` and `dev-package.mjs` do not exist.

- [ ] **Step 2: Implement the shared mode model**

Define immutable production/development records:

```js
export const MODES = Object.freeze({
  prod: {
    profile: "nuanu-flow-prod",
    marketplace: "nuanu",
    pluginName: "nuanu-flow",
    pluginId: "nuanu-flow@nuanu",
    mcpName: "flow",
    mcpUrl: "https://flow.nuanu.com/mcp-server/mcp",
    apiUrl: "https://flow.nuanu.com/api",
    tokenEnv: "NUANU_TOKEN",
    agentKeyEnv: "NUANU_AGENT_KEY",
    workspaceEnv: "NUANU_WORKSPACE",
  },
  dev: {
    profile: "nuanu-flow-dev",
    marketplace: "nuanu-dev",
    pluginName: "nuanu-flow-dev",
    pluginId: "nuanu-flow-dev@nuanu-dev",
    mcpName: "flow_dev",
    mcpUrl: "http://localhost:3001/mcp",
    apiUrl: "http://localhost:8000/api",
    gatewayUrl: "ws://localhost:3100/live/agent-gateway",
    tokenEnv: "NUANU_DEV_TOKEN",
    agentKeyEnv: "NUANU_DEV_AGENT_KEY",
    workspaceEnv: "NUANU_DEV_WORKSPACE",
  },
});
```

`modeConfig("dev", env)` overlays only `NUANU_DEV_MCP_URL`,
`NUANU_DEV_URL`, and `NUANU_DEV_GATEWAY_URL`. Reject unknown modes.

`assertCodexVersion` parses `codex-cli X.Y.Z` and throws when lower than
`0.145.0`.

- [ ] **Step 3: Implement deterministic fingerprinting and atomic generation**

`fingerprintPlugin` recursively hashes relative path, file mode, and bytes for
all files under `plugins/nuanu-flow`, sorted by relative path. Ignore `.DS_Store`.

`buildDevPackage`:

1. Reads the canonical manifest and source fingerprint.
2. Reads `.build/codex-dev/state.json` when present.
3. Returns `changed: false` when fingerprint and requested MCP URL match and
   output files still exist, unless `force` is true.
4. Copies the source plugin into a temporary sibling directory.
5. Rewrites only the copied Codex manifest.
6. Writes a `nuanu-dev` marketplace with `authentication: "ON_USE"`.
7. Writes `state.json` with fingerprint, generated version, MCP URL, and build
   timestamp.
8. Replaces `.build/codex-dev` only after all writes and validation succeed.

Use version format:

```js
`${baseVersion}+codex.local-${utcStamp}.${fingerprint.slice(0, 12)}`
```

- [ ] **Step 4: Replace the old installer with a compatibility shim**

Keep `scripts/codex/dev-install.mjs` executable, but remove all source-manifest
mutation and all operations against marketplace `nuanu`. Its help text says it
is deprecated, maps `--cachebuster` to `force: true`, builds the development
package, registers `.build/codex-dev`, and adds
`nuanu-flow-dev@nuanu-dev`.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
node --test tests/e2e/codex-dev-modes-e2e.test.mjs
node --test tests/e2e/codex-plugin-e2e.test.mjs
git diff --check
```

Expected: PASS; the canonical production manifest remains byte-identical.

- [ ] **Step 6: Commit the package builder**

```bash
git add .gitignore scripts/codex/modes.mjs scripts/codex/dev-package.mjs \
  scripts/codex/dev-install.mjs tests/e2e/codex-dev-modes-e2e.test.mjs \
  tests/e2e/codex-plugin-e2e.test.mjs
git commit -m "feat: generate isolated Codex development plugin"
```

---

### Task 2: Persistent Profiles and Safe Setup

**Files:**
- Create: `scripts/codex/setup.mjs`
- Create: `tests/fixtures/fake-codex.mjs`
- Modify: `tests/e2e/codex-dev-modes-e2e.test.mjs`

**Interfaces:**
- Consumes: `buildDevPackage(options)`
- Consumes: `MODES`, `runCodex`, and repository/Codex-home paths
- Produces: `profileText(mode) -> string`
- Produces: `writeOwnedProfile(path, text) -> Promise<"created"|"updated"|"unchanged">`
- Produces: `classifyMarketplace(entry, repoRoot) -> "remote"|"this-checkout"|"foreign"`
- Produces: `setup(options) -> Promise<SetupReport>`

- [ ] **Step 1: Write failing profile ownership and marketplace migration tests**

Assert exact profile output:

```toml
# Managed by nuanu-agent-tools codex setup. Do not edit.
[plugins."nuanu-flow@nuanu"]
enabled = false

[plugins."nuanu-flow-dev@nuanu-dev"]
enabled = true
```

Test all ownership cases:

```js
assert.equal(await writeOwnedProfile(newPath, devText), "created");
assert.equal(await writeOwnedProfile(newPath, devText), "unchanged");
await assert.rejects(
  writeOwnedProfile(unownedPath, devText),
  /refusing to overwrite unowned Codex profile/,
);
```

Create `tests/fixtures/fake-codex.mjs`. Configure its state and command-log paths
through environment variables so each test gets an isolated temporary state
file. It must implement `--version`, marketplace add/list/upgrade/remove,
plugin add/list/remove, and `mcp list/login`, persist mutations, and never read
the developer's real Codex home. Assert setup:

- removes/re-adds `nuanu` only when it points at this checkout;
- rejects a foreign marketplace named `nuanu`;
- registers `.build/codex-dev` as `nuanu-dev`;
- runs `plugin add` for both plugin IDs;
- never runs `plugin remove` for either plugin.

Run: `node --test tests/e2e/codex-dev-modes-e2e.test.mjs`

Expected: FAIL because setup functions are absent.

- [ ] **Step 2: Implement owned profile writes**

Use this marker exactly:

```js
export const PROFILE_MARKER =
  "# Managed by nuanu-agent-tools codex setup. Do not edit.";
```

Resolve the Codex home from `options.codexHome`, then `process.env.CODEX_HOME`,
then `path.join(os.homedir(), ".codex")`. Create parent directories with mode
`0o700`; write profiles with mode `0o600`.

- [ ] **Step 3: Implement safe setup and migration**

Setup order:

1. Verify Codex version.
2. Generate the development package.
3. Read `codex plugin marketplace list --json`.
4. If `nuanu` is this checkout, remove it and add
   `nuanu-ai/agent-tools --ref main`.
5. If `nuanu` is foreign, stop before making changes.
6. If `nuanu` is absent, add `nuanu-ai/agent-tools --ref main`.
7. Register or refresh `.build/codex-dev` as `nuanu-dev`.
8. Run `codex plugin add nuanu-flow@nuanu --json`.
9. Run `codex plugin add nuanu-flow-dev@nuanu-dev --json`.
10. Write both profiles.

`--dry-run` returns and prints the action plan without changing Codex config or
profiles.

- [ ] **Step 4: Run targeted setup tests**

Run:

```bash
node --test tests/e2e/codex-dev-modes-e2e.test.mjs
FAKE_CODEX_STATE=/tmp/nuanu-fake-codex-state.json \
  FAKE_CODEX_LOG=/tmp/nuanu-fake-codex-log.jsonl \
  node scripts/codex/setup.mjs --dry-run \
  --codex-bin ./tests/fixtures/fake-codex.mjs
```

Expected: tests PASS; dry-run lists production and development as separate
marketplaces and does not mutate the fake state file.

- [ ] **Step 5: Commit profile and setup support**

```bash
git add scripts/codex/setup.mjs tests/fixtures/fake-codex.mjs \
  tests/e2e/codex-dev-modes-e2e.test.mjs
git commit -m "feat: add persistent Codex mode profiles"
```

---

### Task 3: Authentication, Status, and Preflight

**Files:**
- Create: `scripts/codex/auth.mjs`
- Create: `scripts/codex/status.mjs`
- Modify: `scripts/codex/auth-doctor.mjs`
- Modify: `tests/e2e/codex-dev-modes-e2e.test.mjs`

**Interfaces:**
- Consumes: `modeConfig`, Codex process helpers, and owned profile paths
- Produces: `resolveModeCredentials(mode, env, keychain) -> Promise<CredentialResult>`
- Produces: `keychainAccount(mode) -> "nuanu-flow-codex-prod"|"nuanu-flow-codex-dev"`
- Produces: `readMcpAuthStatus(mode, options) -> Promise<"o_auth"|"not_logged_in"|"unsupported"|"unknown">`
- Produces: `probeEndpoint(url, timeoutMs) -> Promise<EndpointStatus>`
- Produces: `collectStatus(options) -> Promise<StatusReport>`
- Produces: `preflight(mode, options) -> Promise<StatusReport>`

- [ ] **Step 1: Write failing auth isolation and redaction tests**

Use an injected fake Keychain adapter:

```js
const devResult = await resolveModeCredentials("dev", {
  NUANU_TOKEN: "prod-secret",
  NUANU_DEV_TOKEN: "dev-secret",
}, fakeKeychain);
assert.equal(devResult.env.NUANU_DEV_TOKEN, "dev-secret");
assert.equal(devResult.env.NUANU_TOKEN, undefined);

const prodResult = await resolveModeCredentials("prod", {
  NUANU_TOKEN: "prod-secret",
  NUANU_DEV_TOKEN: "dev-secret",
}, fakeKeychain);
assert.equal(prodResult.env.NUANU_TOKEN, "prod-secret");
assert.equal(prodResult.env.NUANU_DEV_TOKEN, undefined);
assert.doesNotMatch(JSON.stringify(prodResult.report), /secret/);
```

Start a local HTTP fixture and assert `probeEndpoint` reports reachable,
unreachable, and timeout states without falling back to another URL.

- [ ] **Step 2: Implement credential resolution**

Credential precedence:

1. Selected mode's token environment variable.
2. Selected mode's agent-key environment variable.
3. macOS Keychain token for service `nuanu-flow-codex` and account from
   `keychainAccount(mode)`.
4. No credentials.

The default Keychain adapter uses only `/usr/bin/security`. `auth.mjs
<prod|dev>` reads the selected server's `auth_status` from
`codex --profile <profile> mcp list --json`. If OAuth is available but reports
`not_logged_in`, the interactive command runs
`codex --profile <profile> mcp login <mcpName>` and verifies the resulting
`o_auth` status. If OAuth is `unsupported`, it checks existing selected-mode
credentials. When none are ready and stdin is a macOS TTY, it offers to read a
hidden token and stores it with `security add-generic-password -U`.
`--store-token` forces that replacement prompt, while `--check` is strictly
noninteractive. The token is provided to `security` over stdin and never
appears in argv or logs. On non-macOS systems, return an actionable
environment-variable message without installing software.

- [ ] **Step 3: Implement status and preflight**

`collectStatus` combines:

- `codex --version`;
- `codex plugin marketplace list --json`;
- `codex plugin list --available --json`;
- selected profile existence/ownership;
- generated `state.json`;
- MCP/API endpoint reachability;
- OAuth metadata status from the auth doctor; and
- credential source as `oauth`, `environment-token`, `environment-agent-key`,
  `keychain`, or `missing`.

Human output must include mode, plugin ID, installed/source versions, MCP URL,
API URL, profile path, endpoint health, and auth source. JSON output must omit
all credential values. `status.mjs` reports both modes by default and accepts
`--mode prod|dev` for a focused report.

Development preflight requires the MCP endpoint. Worker development preflight
also requires the API endpoint. Production preflight reports hosted health but
does not switch endpoints on failure.

- [ ] **Step 4: Refactor the auth doctor to use shared classification**

Export `metadataCandidates`, `classifyOAuthProbes`, and `probeOAuthMetadata`
from `auth.mjs`. Keep the existing `codex:auth-doctor` output compatible and add
`--mode prod|dev`.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
node --test tests/e2e/codex-dev-modes-e2e.test.mjs
node --test tests/e2e/codex-plugin-e2e.test.mjs
```

Expected: PASS with no secret values in captured output.

- [ ] **Step 6: Commit auth and diagnostics**

```bash
git add scripts/codex/auth.mjs scripts/codex/status.mjs \
  scripts/codex/auth-doctor.mjs tests/e2e/codex-dev-modes-e2e.test.mjs
git commit -m "feat: persist and diagnose Codex Flow auth"
```

---

### Task 4: Session and Worker Mode Runners

**Files:**
- Create: `scripts/codex/run-mode.mjs`
- Create: `scripts/codex/run-worker.mjs`
- Modify: `package.json`
- Modify: `tests/e2e/codex-dev-modes-e2e.test.mjs`
- Modify: `tests/e2e/worker-e2e.test.mjs`

**Interfaces:**
- Consumes: `buildDevPackage`, `preflight`, `resolveModeCredentials`, and
  `modeConfig`
- Produces: `buildCodexLaunch(mode, options) -> {args, env, cwd, banner}`
- Produces: `buildWorkerLaunch(mode, options) -> {script, env, cwd, banner}`

- [ ] **Step 1: Write failing launch argument and environment tests**

Assert development launch:

```js
assert.deepEqual(devLaunch.args.slice(0, 2), ["--profile", "nuanu-flow-dev"]);
assert.match(devLaunch.banner, /NUANU FLOW LOCAL DEVELOPMENT/);
assert.match(devLaunch.banner, /http:\/\/localhost:3001\/mcp/);
assert.equal(devLaunch.env.NUANU_DEV_TOKEN, "dev-token");
assert.equal(devLaunch.env.NUANU_TOKEN, undefined);
```

Assert production launch:

```js
assert.deepEqual(prodLaunch.args.slice(0, 2), ["--profile", "nuanu-flow-prod"]);
assert.match(prodLaunch.banner, /NUANU FLOW PRODUCTION/);
assert.equal(prodLaunch.env.NUANU_TOKEN, "prod-token");
assert.equal(prodLaunch.env.NUANU_DEV_TOKEN, undefined);
```

Assert worker development mapping:

```js
assert.equal(devWorker.env.NUANU_URL, "http://localhost:8000/api");
assert.equal(devWorker.env.NUANU_AGENT_KEY, "local-agent-key");
assert.equal(devWorker.env.NUANU_ADAPTER, "codex-app-server");
assert.equal(
  devWorker.env.NUANU_CODEX_APP_SERVER_ARGS,
  "--profile nuanu-flow-dev app-server --stdio",
);
```

- [ ] **Step 2: Implement the interactive session runner**

`run-mode.mjs <prod|dev>`:

1. Parse `--cwd`, `--dry-run`, `--no-launch`, `--force-refresh`, and remaining
   Codex args after `--`.
2. For development, build/sync and install the development plugin.
3. Resolve only selected-mode credentials.
4. Run selected-mode preflight.
5. Print the banner before spawning Codex.
6. Spawn the existing Codex binary with inherited stdio.
7. Return Codex's exit code.

Never auto-run setup from production launch. Development may register or
refresh only `nuanu-dev`; if production is not safely configured, report
`npm run codex:setup`.

- [ ] **Step 3: Implement the foreground worker runner**

`run-worker.mjs <prod|dev>` maps mode defaults but preserves explicit caller
overrides. Require selected-mode agent key before spawning
`plugins/nuanu-flow/scripts/worker/worker.mjs`.

For development, map `NUANU_DEV_AGENT_KEY` into the child-only
`NUANU_AGENT_KEY`. Do not add it to `process.env`.

- [ ] **Step 4: Add repository npm scripts**

Replace the old developer entry with:

```json
{
  "codex:setup": "node scripts/codex/setup.mjs",
  "codex:dev": "node scripts/codex/run-mode.mjs dev",
  "codex:prod": "node scripts/codex/run-mode.mjs prod",
  "codex:status": "node scripts/codex/status.mjs",
  "codex:refresh": "node scripts/codex/run-mode.mjs dev --force-refresh --no-launch",
  "codex:auth:prod": "node scripts/codex/auth.mjs prod",
  "codex:auth:dev": "node scripts/codex/auth.mjs dev",
  "worker:dev": "node scripts/codex/run-worker.mjs dev",
  "worker:prod": "node scripts/codex/run-worker.mjs prod"
}
```

Keep `codex:dev-install` as a deprecated compatibility alias for one release.

- [ ] **Step 5: Run session and worker tests**

Run:

```bash
node --test tests/e2e/codex-dev-modes-e2e.test.mjs
node --test tests/e2e/worker-e2e.test.mjs
npm test
```

Expected: PASS; fake Codex logs show profile flags before `app-server`.

- [ ] **Step 6: Commit mode runners**

```bash
git add scripts/codex/run-mode.mjs scripts/codex/run-worker.mjs package.json \
  tests/e2e/codex-dev-modes-e2e.test.mjs tests/e2e/worker-e2e.test.mjs
git commit -m "feat: launch Codex and workers by Flow mode"
```

---

### Task 5: Production Update and Release Versioning

**Files:**
- Create: `scripts/codex/update.mjs`
- Create: `scripts/codex/version.mjs`
- Modify: `package.json`
- Modify: `tests/e2e/codex-dev-modes-e2e.test.mjs`

**Interfaces:**
- Produces: `nextVersion(current, request) -> string`
- Produces: `updateProduction(options) -> Promise<UpdateReport>`
- Consumes: canonical production manifest and Codex process helpers

- [ ] **Step 1: Write failing semver and update command tests**

Cover:

```js
assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
assert.equal(nextVersion("0.1.0", "major"), "1.0.0");
assert.equal(nextVersion("0.1.0", "1.4.2"), "1.4.2");
assert.throws(() => nextVersion("0.1.0", "banana"), /patch, minor, major/);
```

Fake Codex update assertions:

```js
assert.deepEqual(commands, [
  ["plugin", "marketplace", "upgrade", "nuanu", "--json"],
  ["plugin", "add", "nuanu-flow@nuanu", "--json"],
]);
assert.equal(commands.some((args) => args.includes("remove")), false);
```

- [ ] **Step 2: Implement canonical version updates**

`version.mjs` accepts `patch`, `minor`, `major`, or exact `X.Y.Z`. It updates
only `plugins/nuanu-flow/.codex-plugin/plugin.json`, preserves formatting with
two-space JSON indentation, and prints old/new versions. `--dry-run` does not
write.

- [ ] **Step 3: Implement explicit production refresh**

`update.mjs`:

1. Verifies marketplace `nuanu` is Git-backed.
2. Captures installed version.
3. Runs marketplace upgrade.
4. Runs plugin add without plugin remove.
5. Captures resulting installed version.
6. Prints unchanged or `old -> new`.

Stop if `nuanu` is local or foreign and direct the developer to
`npm run codex:setup`.

- [ ] **Step 4: Add npm scripts and run tests**

Add:

```json
{
  "codex:update": "node scripts/codex/update.mjs",
  "plugin:version": "node scripts/codex/version.mjs"
}
```

Run:

```bash
node --test tests/e2e/codex-dev-modes-e2e.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit update/version helpers**

```bash
git add scripts/codex/update.mjs scripts/codex/version.mjs package.json \
  tests/e2e/codex-dev-modes-e2e.test.mjs
git commit -m "feat: add explicit Codex plugin updates"
```

---

### Task 6: Validation, CI, Documentation, and Skill Guidance

**Files:**
- Modify: `scripts/validate-plugins.mjs`
- Modify: `.github/workflows/plugin-ci.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `plugins/nuanu-flow/README.md`
- Modify: `plugins/nuanu-flow/skills/codex-setup/SKILL.md`
- Modify: `tests/e2e/codex-dev-modes-e2e.test.mjs`

**Interfaces:**
- Consumes: `buildDevPackage`
- Produces: `npm run validate:dev`
- Produces: documented developer workflow with no global install step

- [ ] **Step 1: Write failing generated-package validation tests**

Invoke:

```bash
node scripts/validate-plugins.mjs \
  --codex-plugin .build/codex-dev/plugins/nuanu-flow-dev \
  --codex-marketplace .build/codex-dev/.agents/plugins/marketplace.json
```

Assert exit zero for generated output and nonzero after changing a copied
development MCP URL to `https://flow.nuanu.com/mcp-server/mcp`.

- [ ] **Step 2: Extend the validator**

Add argument parsing for optional Codex plugin/marketplace paths while
preserving default validation of production Codex and Claude packages. For a
plugin named `nuanu-flow-dev`, require:

- display name contains `[DEV]`;
- marketplace name is `nuanu-dev`;
- MCP server key is `flow_dev`;
- MCP hostname is `localhost` or `127.0.0.1`; and
- all env-header variables start with `NUANU_DEV_`.

- [ ] **Step 3: Add generated validation to package scripts and CI**

Add:

```json
{
  "build:codex:dev": "node scripts/codex/dev-package.mjs --build-only",
  "validate:dev": "npm run build:codex:dev && node scripts/validate-plugins.mjs --codex-plugin .build/codex-dev/plugins/nuanu-flow-dev --codex-marketplace .build/codex-dev/.agents/plugins/marketplace.json"
}
```

In GitHub Actions, run `npm run validate:dev` between production validation
and E2E tests. Add `docs/plans/**` to workflow path filters.

- [ ] **Step 4: Update documentation**

Root README quick path:

```bash
npm run codex:setup
npm run codex:dev
npm run codex:prod
npm run codex:update
```

State explicitly:

- no Nuanu CLI/global package is installed;
- production and development remain installed separately;
- `npm run codex:dev` never falls back to production;
- start a new Codex session after plugin content changes;
- OAuth is preferred and environment/Keychain auth is transitional.

Update `codex-setup/SKILL.md` to route local development through
`codex:setup`, `codex:dev`, `codex:status`, and `codex:update`. Remove guidance
that replaces marketplace `nuanu` with the checkout.

- [ ] **Step 5: Run full deterministic verification**

Run:

```bash
npm run validate:plugins
npm run validate:dev
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 6: Commit validation and documentation**

```bash
git add scripts/validate-plugins.mjs .github/workflows/plugin-ci.yml package.json \
  README.md plugins/nuanu-flow/README.md \
  plugins/nuanu-flow/skills/codex-setup/SKILL.md \
  tests/e2e/codex-dev-modes-e2e.test.mjs
git commit -m "docs: add Codex production and development workflow"
```

---

### Task 7: Real Codex and App Server Acceptance

**Files:**
- Create: `tests/acceptance/codex-dev-modes-acceptance.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: setup, package builder, profiles, run-mode, run-worker, actual
  Codex login, and the worker App Server adapter
- Produces: `npm run test:acceptance:codex`

- [ ] **Step 1: Build a minimal local Streamable HTTP MCP fixture**

Inside the acceptance script, start an HTTP server on `127.0.0.1` that:

- accepts MCP `initialize`;
- returns protocol version `2025-03-26`;
- exposes `tools/list` with one read-only tool, `flow_dev_identity`;
- returns `{environment:"LOCAL DEVELOPMENT", authenticated:true}` from
  `tools/call`; and
- records every request and presented auth header.

Also start the existing worker HTTP fixture shape with heartbeat,
fetch-and-lock, complete, and fail endpoints.

- [ ] **Step 2: Add credential-free real Codex configuration checks**

Use a temporary Codex home, set `NUANU_DEV_MCP_URL` to the fixture, and run
`scripts/codex/setup.mjs` with the actual Codex binary. Then run:

```bash
codex --profile nuanu-flow-prod mcp list --json
codex --profile nuanu-flow-dev mcp list --json
```

Assert production includes `flow` with only the hosted URL and development
includes `flow_dev` with only the fixture URL. Fail when development output
contains `flow.nuanu.com`.

- [ ] **Step 3: Add explicit model-backed acceptance**

Require `NUANU_RUN_MODEL_ACCEPTANCE=1`. Without it, print a skip reason and
exit zero after credential-free checks.

With opt-in:

1. Snapshot only marketplace/plugin/profile files the test will touch.
2. Run setup against the normal authenticated Codex home, including any
   one-time migration from the old local production marketplace.
3. Capture the production profile's MCP listing, installed version, and
   redacted auth-readiness report as the before-state.
4. Copy `plugins/nuanu-flow` into a temporary source root and build development
   from that copy using the fixture MCP URL.
5. Before every development process, reject the run if the generated manifest,
   `mcp list` output, launch plan, or child environment contains
   `flow.nuanu.com`.
6. Launch `codex exec --profile nuanu-flow-dev --ephemeral` with a prompt that
   requires `flow_dev_identity` and a JSON output schema.
7. Assert the fixture received the call and the response says
   `LOCAL DEVELOPMENT`.
8. Launch a second fresh exec and assert it succeeds without configuration
   changes, proving persisted plugin/profile and available auth state.
9. Add a unique instruction marker to a skill in the temporary plugin source,
   rerun development sync, and assert both the installed development version
   and source fingerprint change.
10. Launch a third fresh exec that explicitly loads the changed development
    skill and assert its schema-constrained response includes the unique marker.
11. Run one local worker task with
    `NUANU_ADAPTER=codex-app-server` and the development profile.
12. Assert the worker completes through real Codex App Server and reports the
    result to the local worker fixture.
13. Re-run the production profile checks and assert its endpoint, installed
    version, and redacted auth readiness match the before-state.
14. Restore all touched Codex state in `finally`.

Never copy or print Codex auth files.

- [ ] **Step 4: Add acceptance script and documentation**

Add:

```json
{
  "test:acceptance:codex": "node tests/acceptance/codex-dev-modes-acceptance.mjs"
}
```

Document:

```bash
npm run test:acceptance:codex
NUANU_RUN_MODEL_ACCEPTANCE=1 npm run test:acceptance:codex
```

The first command validates real Codex packaging/config without model usage.
The second performs model-backed MCP and worker acceptance.

- [ ] **Step 5: Run acceptance and regression verification**

Run:

```bash
npm run test:acceptance:codex
NUANU_RUN_MODEL_ACCEPTANCE=1 npm run test:acceptance:codex
npm run validate:plugins
npm run validate:dev
npm test
git diff --check
```

Expected: both acceptance stages and all regression checks PASS.

- [ ] **Step 6: Commit acceptance coverage**

```bash
git add tests/acceptance/codex-dev-modes-acceptance.mjs package.json README.md
git commit -m "test: add real Codex mode acceptance"
```

---

## Success-Criteria Traceability

| Design criterion | Required proof |
| --- | --- |
| No Nuanu CLI or global package | Task 6 documentation assertions plus the final filesystem/process audit |
| Production and development remain installed | Task 2 fake-Codex state assertions and Task 7 real `plugin list` output |
| Exactly one mode is active per session | Task 2 exact profile tests and Task 7 profile-specific `mcp list` checks |
| Development is unmistakable | Task 1 manifest assertions and Task 4 banner assertions |
| One-command local refresh | Task 4 `codex:refresh` argument test and Task 7 changed-skill reload |
| New sessions reuse configuration/auth | Task 3 auth-state tests and Task 7 second fresh Codex exec |
| Production update is explicit and one command | Task 5 fake-Codex command log |
| Development never falls back to production | Tasks 3 and 4 preflight tests, Task 6 validator rejection, and Task 7 host scan |
| Real local worker completes through App Server | Task 7 local worker fixture completion assertion |

---

## Final Review

- [ ] Compare every success criterion in
  `docs/plans/2026-07-25-codex-dev-prod-modes-design.md` to a passing command or
  assertion in this plan.
- [ ] Run `git status --short` and verify only intended files remain.
- [ ] Run `codex plugin marketplace list --json`, `codex plugin list --json`,
  and `codex mcp list --json`; report production/development IDs, versions,
  enabled state under each profile, and endpoints.
- [ ] Map each design success criterion to at least one deterministic assertion
  or real acceptance assertion and record the command that proves it.
- [ ] Confirm no global binary, npm package, daemon, or shell alias was
  installed.
- [ ] Record any implementation deviation in the design document before final
  handoff.
