# Claude Code Plugin Parity with the Codex Plugin

Date: 2026-08-08
Status: Proposed — not implemented
Scope: `plugins/nuanu-flow`, `plugins/nuanu-flow-worker`, `scripts/claude/**`,
`tests/e2e/**`, `tests/acceptance/**`

## Goal

Bring the Claude Code plugin pair to functional parity with the Codex plugin
pair, so that the same versionless one-prompt entry point —

```text
Read and install https://flow.nuanu.com/install.md
```

— reaches a **working, attached** Nuanu Flow installation on Claude Code, with
the same four capabilities that already work on Codex:

1. domain **skills** load and dispatch;
2. the **`nuanu-flow` MCP** connection authenticates and executes real tools;
3. the machine can enroll and run as a **remote Agent worker**;
4. the **Agent communication bus** is reachable from the worker.

## Non-goals

- Changing the Codex plugin's behavior, layout, or lifecycle.
- Changing Flow server-side OAuth, MCP, or Agent-bus APIs. Live probing on
  2026-08-08 confirmed the server side is correct and complete (see Findings).
- Automating Claude MCP OAuth from an agent-controlled shell. `install.md`
  forbids it and this plan upholds that rule.
- Building a Nuanu-specific CLI, global npm package, or shell alias.
- Publishing to the official Anthropic plugin directory (tracked separately;
  see Distribution notes).

---

## Findings (live, 2026-08-08)

Measured against `claude 2.1.226`, installed plugin `nuanu-flow@nuanu`
version `b7618517ddf3` (2026-07-22), production `flow.nuanu.com`.

| Capability | Codex | Claude | Evidence |
| --- | --- | --- | --- |
| Skills load | ✓ | ✓ | `claude -p` headless returned all 10 `nuanu-flow:*` skills |
| MCP attached | ✓ | ✕ | `claude mcp list` → `plugin:nuanu-flow:mcp … ! Needs authentication` |
| Worker installed | ✓ | ✕ | `nuanu-flow-worker` absent from `claude plugin list --json` |
| Agent bus | ✓ | ✕ | `NUANU_AGENT_BUS_SCRIPT` is set only by `scripts/codex/run-worker.mjs` |
| Test suite | ✓ | ✓ (false) | 84/84 pass; Claude tests drive a **fake** `claude` binary |

Server-side is healthy and is **not** a cause:

- `POST /mcp-server/mcp` unauthenticated → `401` with a correct
  `WWW-Authenticate: Bearer resource_metadata=…, scope="flow:full"`.
- `/.well-known/oauth-protected-resource/mcp-server/mcp` and
  `/.well-known/oauth-authorization-server` both resolve, advertising
  `authorization_code` + `refresh_token`, PKCE `S256`, and dynamic
  registration.
- Repeating the probe **with** the empty-valued headers Claude currently sends
  (`X-Plane-User-Token: ""`, `X-Agent-Key: ""`, `X-Plane-Workspace: ""`,
  `X-Agent-Client: Claude Code`) returns the **same** correct challenge. The
  empty headers are cosmetic, not the blocker.

### Root causes, ranked

**RC1 — Nothing ever completes OAuth on Claude.**
`.codex-plugin/plugin.json` declares `"auth": "oauth"` and the Codex
marketplace policy is `"authentication": "ON_INSTALL"`, so Codex drives the
flow during install. Claude has no ON_INSTALL equivalent, and
`installClaude()` (`scripts/claude/install.mjs`) sets
`deferAuth = remoteAgent || options.skipAuth || isDesktop || !interactive`,
where `interactive` requires `process.stdin.isTTY && process.stdout.isTTY`.
An agent-driven one-prompt install is never a TTY, so **`deferAuth` is always
true** and the install always terminates at "installed, not authenticated".
Parity must therefore be built from a *reliable guided handoff*, not a config
flag.

**RC2 — Production install cannot obtain the current layout.**
The whole worker split is uncommitted. `claude plugin marketplace add
nuanu-ai/agent-tools` pulls from GitHub, so the one-prompt production path
cannot produce the post-split pair at all. The currently installed build
predates the split entirely — it has no `hooks/` directory and no `hooks` key.

**RC3 — The worker plugin is a dead shell on Claude.**
`plugins/nuanu-flow-worker/hooks/hooks.json` uses `${PLUGIN_ROOT}` and
`commandWindows` — both Codex-isms Claude does not expand. There is no
`claude-hooks.json` counterpart (the general plugin has one; the worker does
not), and `.claude-plugin/plugin.json` declares no `hooks` key. The
`UserPromptSubmit` catch-up hook therefore never runs on Claude. There is also
no `scripts/claude/run-worker.mjs`: Codex has `worker:dev` / `worker:prod`,
Claude has no launcher and no `claude:worker:*` npm scripts.

**RC4 — The Agent bus is structurally unreachable on Claude.**
`NUANU_AGENT_BUS_SCRIPT` is assigned in exactly one place —
`scripts/codex/run-worker.mjs:104` — from a **repo-root** path
(`plugins/nuanu-flow/scripts/agent-bus/agent-bus.mjs`). In a real installation
the two plugins live in separate content-hashed cache directories and nothing
resolves the general plugin's root, so `loadAgentBusAdapter` returns
`status: "degraded", reason: "not_configured"` and the bus silently no-ops.
`commands/worker.md` instructs the model to "resolve the enabled matching
`nuanu-flow` companion through the host plugin registry" — that is prose, not
code.

The fix exists and is verified: `claude plugin list --json` returns a per-plugin
`installPath`, which makes registry resolution genuinely implementable.

**RC5 — Test rigor asymmetry caused the implementation asymmetry.**
`tests/e2e/claude-plugin-e2e.test.mjs` only reads JSON manifests and drives
`createFakeClaude()`. Nothing exercises a real install, real OAuth, real skill
dispatch, or a real worker. Codex has
`tests/acceptance/codex-dev-modes-acceptance.mjs` with `--model`, `--journey`,
and `--worker-only` live modes. Claude's `test:acceptance:claude:live` target
exists but does not cover MCP, worker, or bus. RC1–RC4 all survived a green
suite because of this.

---

## Vendor-pattern gate

Required by `CLAUDE.md` before any plugin lifecycle/packaging change. Compared
against two current official vendor implementations plus the live Plane/Flow
server implementation.

### Warp — `warpdotdev/claude-code-warp` (marketplace `claude-code-warp`, v2.1.0)

The closest structural analogue: **two sibling plugins in one marketplace**,
where the companion (`oz-harness-support`) delivers out-of-band parent messages
into a Claude session via `UserPromptSubmit` — the same shape as the Nuanu
worker's catch-up hook.

| Pattern | Verdict |
| --- | --- |
| Hooks at `hooks/hooks.json` with **no `hooks` key** in `plugin.json` (auto-discovery) | **Adopt.** Both Warp plugins rely on it. Removes a manifest field that is easy to forget — which is precisely how RC3 happened. |
| All hook commands use `${CLAUDE_PLUGIN_ROOT}` | **Adopt.** Already used by the general plugin; extend to the worker. |
| `version` declared in **both** `plugin.json` and the marketplace entry | **Adopt.** Nuanu's Claude marketplace entries currently omit `version`. |
| Companion plugin does mailbox drain on `UserPromptSubmit` | **Adopt as validation.** Confirms the existing worker catch-up design is idiomatic; no change needed beyond wiring it up for Claude. |
| Plain `.sh` hook scripts | **Reject.** Nuanu's Node hooks are cross-platform and already tested; shell scripts would regress Windows support. |

### Anthropic — `anthropics/claude-plugins-official` (marketplace `claude-plugins-official`)

| Pattern | Verdict |
| --- | --- |
| Distribution via `source: {source: "git-subdir", url, path, ref, sha}` with a **pinned sha** | **Adopt when listing.** Gives reproducible installs; note the `nuanu` marketplace currently uses a bare `./plugins/...` local source, which is correct for a self-owned marketplace. |
| `renames` map at marketplace level for migrating plugin names | **Note.** Directly useful if `nuanu-flow` is ever split or renamed again; not needed now. |
| `.mcp.json` in `plugins/example-plugin/` uses a **bare server map** (no `mcpServers` wrapper) | **Reject.** Nuanu's `{"mcpServers": {...}}` form is *proven working* — the live `claude plugin list --json` shows the server registered as `plugin:nuanu-flow:mcp`. Do not churn a working config toward an example. |
| No official plugin declares OAuth config in `.mcp.json` | **Confirm.** Claude Code performs OAuth natively on a `401` + `WWW-Authenticate` challenge. There is no manifest-level auth field to add; RC1 is a *flow* problem, not a *config* problem. |

### Plane / Flow server (live production)

MCP authorization is implemented to spec (RFC 9728 protected-resource metadata,
OAuth 2.1 + PKCE, dynamic client registration). Header-based auth
(`X-Plane-User-Token` / `X-Agent-Key`) is offered as an explicit alternative in
the 401 body. **Adopt:** keep the header path for the headless worker and the
OAuth path for humans — the split the Codex plugin already uses.

### Pattern conflict surfaced by this research

Warp proves Claude auto-discovers `hooks/hooks.json`. The general plugin
currently ships **both** `hooks/hooks.json` (Codex, `${PLUGIN_ROOT}`) and
`hooks/claude-hooks.json` (Claude, `${CLAUDE_PLUGIN_ROOT}`) and names the
latter explicitly. If auto-discovery and the explicit key both apply, Claude
would additionally run the Codex file with an unexpanded `${PLUGIN_ROOT}`,
producing a broken command every session.

This is **unverified** — the installed build is too old to exhibit it — and it
is task T0 below, because the chosen file naming depends on the answer.

Resolution if the collision is real (recommended regardless, as it removes the
hazard by construction):

- `hooks/hooks.json` → **Claude-canonical**, `${CLAUDE_PLUGIN_ROOT}`, no
  `hooks` key in `.claude-plugin/plugin.json` (Warp convention);
- `hooks/codex-hooks.json` → Codex, `${PLUGIN_ROOT}` + `commandWindows`, named
  explicitly by `.codex-plugin/plugin.json`.

This inverts today's naming. Codex already references its hooks file
explicitly, so it costs one manifest string on the Codex side and removes an
entire class of failure on the Claude side.

---

## Design

### Codex → Claude capability mapping

| Concern | Codex mechanism | Claude mechanism |
| --- | --- | --- |
| Skills | `"skills": "./skills"` in manifest | auto-discovered `skills/` — **already works** |
| Hooks | `hooks.json`, `${PLUGIN_ROOT}`, `commandWindows` | auto-discovered `hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}` |
| MCP | `mcpServers` in manifest + `"auth": "oauth"` | `.mcp.json` + native 401→OAuth |
| Auth trigger | marketplace `authentication: ON_INSTALL` | **no equivalent** → guided `/mcp` handoff |
| Isolated dev | `CODEX_HOME=~/.codex/nuanu-flow/dev` | `.build/claude-dev` marketplace + `-dev` plugin names |
| Worker launch | `scripts/codex/run-worker.mjs` | **missing** → `scripts/claude/run-worker.mjs` |
| Bus path | repo-root constant | `claude plugin list --json` → `installPath` |

### Key decision: how Claude reaches "authenticated"

Claude Code cannot authenticate an MCP server during a non-interactive install,
and `install.md` explicitly bans wrapping `claude mcp login` in a pseudo-TTY.
So parity is achieved by making the three lifecycle states **machine-checkable**
and the handoff **exact**, rather than by automating OAuth:

1. `installClaude()` returns `authentication: "user_action_required"` (today it
   returns the ambiguous `"skipped"`), plus the literal two commands the user
   must enter.
2. A new `scripts/claude/status.mjs` — mirroring `scripts/codex/status.mjs` —
   parses `claude mcp list` and reports `installed` / `authenticated` /
   `attached` independently, so the agent never *infers* attachment.
3. The `SessionStart` hook surfaces "installed but not authenticated" once, so
   a later session self-heals instead of appearing silently broken.

This keeps the one-prompt entry point intact: the prompt still does everything
a non-interactive process is permitted to do, and stops at a single, precisely
stated user action.

---

## Implementation tasks

Waves are ordered by dependency. Each task is independently verifiable.

### T0 — Verify the hook-discovery collision (blocks T1) — **DONE**

**Result: the collision is real.** Verified 2026-08-08 with an instrumented
copy of the general plugin loaded via `claude --plugin-dir`, where both hook
files invoked a distinct marker script (both using `${CLAUDE_PLUGIN_ROOT}`, so
the experiment isolated *discovery* from *variable expansion*):

| Case | Layout | Markers written |
| --- | --- | --- |
| A | manifest names `claude-hooks.json`, `hooks.json` also present | **both** files fired |
| B | no `hooks` key; `hooks.json` + `codex-hooks.json` | only `hooks.json` fired |

In the shipped layout Claude was therefore running the Codex `hooks.json` on
every session with an unexpanded `${PLUGIN_ROOT}`, i.e. a broken command per
session, silently. Case B is the adopted layout.

- [x] Determine whether Claude runs `hooks/hooks.json` in addition to the
      manifest-named file — **yes, it runs both**.
- [x] Apply the file-naming inversion from the vendor-gate section.
- [x] Add a regression test asserting no plugin exposes a Codex-rooted hook
      config to Claude auto-discovery
      (`tests/e2e/claude-plugin-e2e.test.mjs`).

### T1 — Worker plugin Claude wiring (fixes RC3) — **DONE**

- [x] `hooks/hooks.json` is now the Claude-canonical, auto-discovered file in
      both plugins; `hooks/codex-hooks.json` holds the Codex config and is
      named explicitly by each `.codex-plugin/plugin.json`.
- [x] Worker `UserPromptSubmit` hook rewritten with `${CLAUDE_PLUGIN_ROOT}`,
      preserving `additionalContextLimit: 500` and `timeout: 1`.
- [x] `hooks` key removed from both `.claude-plugin/plugin.json` manifests.
- [x] Codex hook configs unchanged in behavior.
- [x] `version` added to both Claude marketplace entries.

### T2 — Claude worker launcher and bus resolution (fixes RC4) — **DONE**

- [x] `scripts/claude/run-worker.mjs` added, resolving both plugin roots from
      `claude plugin list --json` (`installPath`), asserting the agent-bus and
      worker scripts exist, and applying the same dev-loopback / prod-origin
      URL rules as the Codex launcher.
- [x] Fails fast on: plugin not installed, plugin disabled, missing
      `installPath`, missing script, and a mixed dev/prod pair.
- [x] `claude:worker:dev` and `claude:worker:prod` npm scripts.
- [x] `commands/worker.md` and `skills/claude-code-remote-worker/SKILL.md`
      updated; `npm run sync:skills` run.

Live verification against local dev Flow (2026-08-08), dev pair installed into
an isolated `CLAUDE_CONFIG_DIR`:

```text
NUANU FLOW DEVELOPMENT WORKER (Claude Code)
API: http://localhost:8000/api
Adapter: claude-code
Agent bus: …/nuanu-flow-dev/…/scripts/agent-bus/agent-bus.mjs
  agent_bus=ready
  heartbeat failed: HTTP 401 /agent-worker/heartbeat/: {"detail":"Invalid agent key"}
```

The `401 Invalid agent key` is the expected response to a synthetic key and
proves transport, routing, and auth are wired end to end. The remaining step —
claiming and executing a real task — needs a `nuanu_join_` enrollment token
from the local Flow UI.

Fail-fast rails verified live:

```text
prod mode, dev pair installed → Refusing to start a production worker while
                                nuanu-flow-dev@nuanu-dev is also enabled.
dev mode, empty Claude home   → nuanu-flow-dev@nuanu-dev is not installed.
```

### T3 — Lifecycle state honesty (fixes RC1)

- [ ] Change `installClaude()` to return
      `authentication: "user_action_required"` instead of `"skipped"` when
      `deferAuth` is true for a non-remote-agent install.
- [ ] Add `scripts/claude/status.mjs` reporting installed / authenticated /
      attached as three independent states parsed from `claude mcp list`.
- [ ] Add a `claude:status` npm script.
- [ ] Extend `hooks/session-start.mjs` to surface a one-line
      "installed, not yet authenticated" notice, within the existing 1s
      timeout, silent when already attached.
- [ ] Drop empty-valued headers from `.mcp.json` where they add nothing
      (cosmetic; verified not to affect the OAuth challenge).

### T4 — Real Claude e2e coverage (fixes RC5)

Replace fake-CLI-only coverage. Gate live tests behind `NUANU_LIVE=1` so the
default `npm test` stays hermetic and offline.

- [ ] Add `tests/e2e/claude-live-e2e.test.mjs` covering, against **local dev
      Flow**:
  - [ ] real `claude plugin marketplace add .build/claude-dev`;
  - [ ] real `claude plugin install` of **both** plugins, both enabled;
  - [ ] real `claude -p` headless skill dispatch (this technique is already
        proven — it returned all 10 skill names on 2026-08-08);
  - [ ] real `claude mcp list` parse asserting the dev server is registered at
        `http://localhost:3001/mcp`;
  - [ ] real worker enrollment against local Flow, one successful heartbeat,
        and `agent_bus=ready` in the worker banner — the assertion that would
        have caught RC4;
  - [ ] one round-trip Agent-bus message delivered and acknowledged.
- [ ] Extend `tests/acceptance/claude-plugin-acceptance.mjs` with
      `--worker-only` and `--journey` modes matching the Codex acceptance
      surface.
- [ ] Add `claude:install:worker:dev` to the acceptance path so the paired
      install is exercised, not just the general plugin.

### T5 — Ship (fixes RC2)

- [ ] Atomic commits of the worker split and all of the above.
- [ ] Push to `nuanu-ai/agent-tools` — **the production one-prompt install is
      broken until this lands**, because it installs from GitHub.
- [ ] Bump `version` in all four plugin manifests together (they are asserted
      equal by `claude-plugin-e2e.test.mjs`).
- [ ] Re-run `npm run validate:plugins` and `npm run validate:dev`.
- [ ] Verify a clean production one-prompt install on a scratch Claude home.

---

## Live e2e test plan (local dev Flow)

Prerequisites — all four must be reachable before the run:

| Endpoint | Purpose |
| --- | --- |
| `http://localhost:3000/` | web + `install.md` one-prompt source |
| `http://localhost:3001/health` | MCP server health |
| `http://localhost:3001/.well-known/oauth-protected-resource` | OAuth discovery |
| `http://localhost:8000/api/` | Flow API |
| `ws://localhost:3100/live/agent-gateway` | Agent-bus gateway (worker) |

Sequence:

1. **Clean slate** — `npm run claude:remove`, confirm no `nuanu*` marketplace
   or plugin remains.
2. **One-prompt install** — drive the real entry prompt against
   `http://localhost:3000/install.md`, letting the agent select Claude Code and
   local development, and run `npm run claude:install:worker:dev`.
3. **Skills** — headless `claude -p` assertion on the `nuanu-flow:*` skill set,
   including the worker plugin's three skills.
4. **MCP** — `claude mcp list` shows the dev server; then the single permitted
   manual step: `/reload-plugins`, then `/mcp` → Authenticate. Prove attachment
   with a real `onboarding_next` call.
5. **Worker** — enroll with a `nuanu_join_` token from local Flow, start via
   `npm run claude:worker:dev`, assert heartbeat and `agent_bus=ready`.
6. **Agent bus** — publish a message to the enrolled Agent, assert delivery and
   acknowledgement, and assert the `UserPromptSubmit` catch-up hook surfaces it
   in a Claude session.
7. **Teardown** — `npm run claude:remove`; confirm the production Codex
   installation is untouched.

Step 4's manual sub-step is the only human action in the sequence and is
required by `install.md`. Everything before and after it is automatable.

---

## Risks and open questions

| Risk | Mitigation |
| --- | --- |
| T0 collision result changes the file layout | T0 is sequenced first and blocks T1 |
| `claude plugin list --json` shape is unstable across versions | Pin the minimum to `2.1.207` (already in the compatibility matrix), assert `installPath` presence, fail fast with a clear message |
| Dev and prod plugin pairs coexisting and cross-linking | Launcher rejects a general/worker pair from different modes (T2) |
| Live tests writing to production Flow | Launcher already enforces loopback-only URLs in dev; keep `NUANU_LIVE=1` gating |
| `/reload-plugins` unavailable in Desktop Code tab | Already documented; acceptance must assert the new-session path, not the command |

Open questions for the maintainer:

1. Should `nuanu-flow-worker` be installable **standalone**, or always require
   the general plugin? Current code degrades gracefully; the launcher in T2
   would fail fast. Fail-fast is recommended — a silently degraded bus is what
   made RC4 invisible.
2. Is the official Anthropic directory listing in scope this cycle? If yes, the
   `git-subdir` + pinned-sha source form should be adopted in T5.

## Appendix — Unpublished-install routes (verified 2026-08-08)

Requirement: installation must work **before** the plugin is listed in the
official Anthropic directory, and ideally before it is even pushed to GitHub.
All three routes were tested live against an isolated `CLAUDE_CONFIG_DIR`; the
production config directory was verified untouched afterwards.

| Route | Command | Result |
| --- | --- | --- |
| **Local directory** | `claude plugin marketplace add /path/to/agent-tools` | ✓ **works today** |
| **GitHub repo** | `claude plugin marketplace add nuanu-ai/agent-tools` | ✓ works once pushed (blocked by RC2) |
| **Hosted URL** | `claude plugin marketplace add https://…/marketplace.json` | ✓ adds · ✕ **install fails** |

### Local directory — verified end to end

From the **uncommitted, unpushed** working tree:

```text
✔ Successfully added marketplace: nuanu   (source: "directory")
✔ Successfully installed plugin: nuanu-flow@nuanu         (scope: user)
✔ Successfully installed plugin: nuanu-flow-worker@nuanu  (scope: user)
```

Both enabled. All assets survive the install — the general plugin ships 14
skills plus `scripts/agent-bus/agent-bus.mjs`, the worker ships 3 skills plus
the full `scripts/worker/` tree. Resolving both `installPath` values from
`claude plugin list --json` and launching the worker produced:

```text
adapter=claude-code   agent_bus=ready
```

This is task T2's resolution strategy **validated against a real installed
plugin pair**, not a checkout. It confirms T-1 is a small, low-risk script.

The same run also re-confirms RC3 in situ: the installed worker ships only
`hooks/hooks.json` (Codex `${PLUGIN_ROOT}`) with no `claude-hooks.json`.

### Hosted URL — adds, but cannot install

`marketplace add <url>` is genuinely supported (`Downloading marketplace from
… → Validating → Saving to cache → ✔ added`). Installation then fails:

```text
✘ Source path does not exist:
  <config>/plugins/marketplaces/nuanu/plugins/nuanu-flow
```

Cause: `marketplace.json` declares `"source": "./plugins/nuanu-flow"`, which
resolves against the cached marketplace directory — and that directory contains
only the downloaded JSON, never the plugin payload. Relative sources are valid
only for `directory` and `git` marketplaces.

To make the hosted route work, each plugin entry needs a **remote** source.
Source types present in the 2.1.226 binary: `git-subdir`, `github`, `git`,
`npm`, plus archive/tarball handling. `git-subdir` (the form Anthropic's own
directory uses, with a pinned `sha`) reintroduces the GitHub dependency; `npm`
would be the only route fully independent of both GitHub and the directory.

**Hazard to fix regardless:** `https://flow.nuanu.com/.claude-plugin/marketplace.json`
currently returns **SPA fallback HTML with HTTP 200**, as do `/marketplace.json`
and `/plugins/marketplace.json`. Anyone pointing `marketplace add` at those URLs
downloads HTML and gets a confusing validation error rather than a clean 404.
Either serve a real manifest there or make the path 404.

### T6 — Unpublished-install support (new task)

- [ ] Decide the pre-listing distribution route: GitHub `git-subdir` (fast, one
      push) versus `npm` (fully independent, needs a publish pipeline).
- [ ] Make `/connect/claude-code.md` state the local-directory route explicitly
      for internal and pre-release installs — it is the only route that works
      with zero publication of any kind, and it is currently undocumented.
- [ ] Fix or 404 the three `marketplace.json` paths on `flow.nuanu.com`.
- [ ] If the hosted route is adopted, convert both Claude marketplace entries
      from relative `./plugins/...` to the chosen remote source form, and keep
      the local-directory marketplace for dev mode.
- [ ] Add a regression test asserting a URL-added marketplace can actually
      install, not merely register.

## Appendix — Worker workaround available today (verified 2026-08-08)

"Claude as a worker" has two distinct meanings, and only one of them is broken.

**Claude as the execution engine — already works.** `makeAdapter()` in
`plugins/nuanu-flow-worker/scripts/worker/adapter.mjs` defaults to
`claude-code` (`cfg.type || "claude-code"`), with full `claude -p` invocation,
`--resume` session continuity keyed on `thread_id`/`run_id`, permission-mode and
allowed-tools plumbing, and streaming output parsing. `tests/e2e/worker-e2e.test.mjs`
covers it ("worker completes a task through first-class Claude Code streaming
mode"). Nothing in RC1–RC4 touches this.

**Claude Code as the worker *host* — broken, but bypassable.** The daemon is
plain host-agnostic Node. Its only hard requirements are `NUANU_URL`,
`NUANU_AGENT_KEY` (or an enrolled credential), Node ≥ 20.6, and a `claude`
binary on PATH. It does not need the plugin at all — the plugin only supplies
enrollment UX, the `/worker` command, the catch-up hook, and the bus path.

Verified by running the daemon directly from the checkout with the bus path
passed explicitly:

```bash
NUANU_URL="http://localhost:8000/api" \
NUANU_AGENT_KEY="nuanu_flow_…" \
NUANU_AGENT_BUS_SCRIPT="$PWD/plugins/nuanu-flow/scripts/agent-bus/agent-bus.mjs" \
node plugins/nuanu-flow-worker/scripts/worker/worker.mjs
```

Startup banner:

```text
adapter=claude-code  transport=poll  maxConcurrency=1  lock=300s
capabilities=checkpoint_v1,human_input_v1,lease_renewal_v1,repository_read_write_v1
agent_bus=ready
```

`agent_bus=ready` outside Codex, with zero code changes. This is the single
most useful finding for sequencing: RC4 is a *path-resolution* defect in the
launcher layer, not a design defect in the bus.

### Workaround tiers

| Tier | Cost | Covers | Gap |
| --- | --- | --- | --- |
| **T-0** run daemon from a checkout with explicit env | none — works today | task execution, agent bus, heartbeat | needs a checkout; manual env |
| **T-1** `scripts/claude/run-worker.mjs` (task T2) | ~1 script | same, for *installed* plugin users via `installPath` | still no in-session observability |
| **T-2** full plan (T1–T5) | full | adds catch-up hook, session activity, one-prompt install | — |

What no workaround gives you until T1 lands:

- The `UserPromptSubmit` catch-up hook — worker activity will not surface in a
  Claude session, because the worker's hook file is `${PLUGIN_ROOT}`-wired.
- Session-scoped activity attach. `config.mjs` reads
  `NUANU_OWNER_SESSION_ID || CODEX_THREAD_ID`, so the generic variable exists,
  but Claude auto-populates no equivalent and the banner message
  (`unavailable (no Codex session id)`) is Codex-centric. Passing
  `NUANU_OWNER_SESSION_ID` explicitly is possible; nothing reads it back on
  Claude until the hook is fixed.

Recommendation: T-0 unblocks live worker and agent-bus e2e **immediately**,
including steps 5 and 6 of the live test plan, without waiting for any of
T1–T5. Promote to T-1 before asking anyone outside the team to run a worker.

## Definition of done

- A clean machine, given only the one-prompt entry point and one `/mcp`
  authentication, reaches a Claude Code session where a real `onboarding_next`
  call succeeds.
- `npm run claude:worker:dev` starts a worker reporting `agent_bus=ready` and a
  successful heartbeat.
- An Agent-bus message round-trips and surfaces in a Claude session.
- `NUANU_LIVE=1 npm test` passes, and the default `npm test` still passes
  offline.
- Codex behavior is byte-for-byte unchanged; `npm run validate:plugins` and
  `npm run validate:dev` both pass.
