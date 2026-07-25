import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCodexVersion,
  modeConfig,
} from "../../scripts/codex/modes.mjs";
import {
  buildDevPackage,
  fingerprintPlugin,
} from "../../scripts/codex/dev-package.mjs";
import {
  PROFILE_MARKER,
  classifyMarketplace,
  profileText,
  setup,
  writeOwnedProfile,
} from "../../scripts/codex/setup.mjs";
import {
  classifyOAuthProbes,
  keychainAccount,
  metadataCandidates,
  probeEndpoint,
  readMcpAuthStatus,
  resolveModeCredentials,
} from "../../scripts/codex/auth.mjs";
import {
  collectStatus,
  preflight,
} from "../../scripts/codex/status.mjs";
import {
  buildCodexLaunch,
  parseRunModeArgs,
} from "../../scripts/codex/run-mode.mjs";
import { buildWorkerLaunch } from "../../scripts/codex/run-worker.mjs";
import {
  nextVersion,
  updateManifestVersion,
} from "../../scripts/codex/version.mjs";
import { updateProduction } from "../../scripts/codex/update.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePluginRoot = path.join(repoRoot, "plugins/nuanu-flow");
const fakeCodexBin = path.join(repoRoot, "tests/fixtures/fake-codex.mjs");

async function makeTempPlugin() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-codex-modes-"));
  const pluginRoot = path.join(tempRoot, "source-plugin");
  const buildRoot = path.join(tempRoot, "build");
  await fs.cp(sourcePluginRoot, pluginRoot, { recursive: true });
  return {
    tempRoot,
    pluginRoot,
    buildRoot,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readCommandLog(file) {
  try {
    return (await fs.readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function startHttpFixture(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("modeConfig isolates production and development endpoints and credentials", () => {
  const dev = modeConfig("dev", {
    NUANU_DEV_MCP_URL: "http://127.0.0.1:4321/mcp",
    NUANU_DEV_URL: "http://127.0.0.1:4322/api",
    NUANU_DEV_GATEWAY_URL: "ws://127.0.0.1:4323/live/agent-gateway",
  });
  assert.equal(dev.pluginId, "nuanu-flow-dev@nuanu-dev");
  assert.equal(dev.profile, "nuanu-flow-dev");
  assert.equal(dev.mcpName, "flow_dev");
  assert.equal(dev.mcpUrl, "http://127.0.0.1:4321/mcp");
  assert.equal(dev.apiUrl, "http://127.0.0.1:4322/api");
  assert.equal(dev.gatewayUrl, "ws://127.0.0.1:4323/live/agent-gateway");
  assert.equal(dev.tokenEnv, "NUANU_DEV_TOKEN");
  assert.equal(dev.agentKeyEnv, "NUANU_DEV_AGENT_KEY");
  assert.equal(dev.workspaceEnv, "NUANU_DEV_WORKSPACE");

  const prod = modeConfig("prod", {
    NUANU_DEV_MCP_URL: "http://127.0.0.1:9999/mcp",
  });
  assert.equal(prod.pluginId, "nuanu-flow@nuanu");
  assert.equal(prod.profile, "nuanu-flow-prod");
  assert.equal(prod.mcpName, "flow");
  assert.equal(prod.mcpUrl, "https://flow.nuanu.com/mcp-server/mcp");
  assert.equal(prod.apiUrl, "https://flow.nuanu.com/api");
  assert.equal(prod.tokenEnv, "NUANU_TOKEN");

  assert.throws(() => modeConfig("staging", {}), /Unknown Nuanu Flow mode/);
});

test("assertCodexVersion enforces the supported Codex baseline", () => {
  assert.doesNotThrow(() => assertCodexVersion("codex-cli 0.145.0"));
  assert.doesNotThrow(() => assertCodexVersion("codex-cli 1.0.0"));
  assert.throws(() => assertCodexVersion("codex-cli 0.144.9"), /0\.145\.0 or newer/);
  assert.throws(() => assertCodexVersion("not-codex"), /Could not parse Codex version/);
});

test("fingerprintPlugin is stable and changes when distributable content changes", async () => {
  const fixture = await makeTempPlugin();
  try {
    const first = await fingerprintPlugin(fixture.pluginRoot);
    const second = await fingerprintPlugin(fixture.pluginRoot);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(second, first);

    await fs.appendFile(
      path.join(fixture.pluginRoot, "skills/nuanu-flow/SKILL.md"),
      "\nLocal acceptance marker.\n",
    );
    const changed = await fingerprintPlugin(fixture.pluginRoot);
    assert.notEqual(changed, first);
  } finally {
    await fixture.cleanup();
  }
});

test("buildDevPackage generates an isolated development marketplace without mutating production", async () => {
  const fixture = await makeTempPlugin();
  const manifestPath = path.join(fixture.pluginRoot, ".codex-plugin/plugin.json");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  try {
    const result = await buildDevPackage({
      pluginRoot: fixture.pluginRoot,
      buildRoot: fixture.buildRoot,
      env: {},
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });

    assert.equal(result.changed, true);
    assert.match(
      result.version,
      /^0\.1\.0\+codex\.local-20260725-120000\.[a-f0-9]{12}$/,
    );
    assert.equal(result.marketplaceRoot, fixture.buildRoot);
    assert.equal(
      result.pluginRoot,
      path.join(fixture.buildRoot, "plugins/nuanu-flow-dev"),
    );

    const manifest = await readJson(
      path.join(result.pluginRoot, ".codex-plugin/plugin.json"),
    );
    assert.equal(manifest.name, "nuanu-flow-dev");
    assert.equal(manifest.version, result.version);
    assert.equal(manifest.interface.displayName, "Nuanu Flow [DEV]");
    assert.match(manifest.interface.shortDescription, /local development/i);
    assert.deepEqual(Object.keys(manifest.mcpServers), ["flow_dev"]);
    assert.equal(manifest.mcpServers.flow_dev.url, "http://localhost:3001/mcp");
    assert.equal(
      manifest.mcpServers.flow_dev.env_http_headers["X-Plane-User-Token"],
      "NUANU_DEV_TOKEN",
    );
    assert.equal(
      manifest.mcpServers.flow_dev.env_http_headers["X-Agent-Key"],
      "NUANU_DEV_AGENT_KEY",
    );
    assert.equal(
      manifest.mcpServers.flow_dev.env_http_headers["X-Plane-Workspace"],
      "NUANU_DEV_WORKSPACE",
    );

    const marketplace = await readJson(
      path.join(result.marketplaceRoot, ".agents/plugins/marketplace.json"),
    );
    assert.equal(marketplace.name, "nuanu-dev");
    assert.equal(marketplace.interface.displayName, "Nuanu Development");
    assert.equal(marketplace.plugins[0].name, "nuanu-flow-dev");
    assert.deepEqual(marketplace.plugins[0].source, {
      source: "local",
      path: "./plugins/nuanu-flow-dev",
    });
    assert.equal(marketplace.plugins[0].policy.authentication, "ON_USE");

    const state = await readJson(path.join(result.marketplaceRoot, "state.json"));
    assert.equal(state.fingerprint, result.fingerprint);
    assert.equal(state.version, result.version);
    assert.equal(state.mcpUrl, "http://localhost:3001/mcp");
    assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  } finally {
    await fixture.cleanup();
  }
});

test("buildDevPackage skips unchanged output and force refreshes its cachebuster", async () => {
  const fixture = await makeTempPlugin();
  let tick = 0;
  const now = () =>
    new Date(tick++ === 0 ? "2026-07-25T12:00:00.000Z" : "2026-07-25T12:01:00.000Z");
  try {
    const first = await buildDevPackage({
      pluginRoot: fixture.pluginRoot,
      buildRoot: fixture.buildRoot,
      env: {},
      now,
    });
    const unchanged = await buildDevPackage({
      pluginRoot: fixture.pluginRoot,
      buildRoot: fixture.buildRoot,
      env: {},
      now,
    });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.version, first.version);

    const refreshed = await buildDevPackage({
      pluginRoot: fixture.pluginRoot,
      buildRoot: fixture.buildRoot,
      env: {},
      now,
      force: true,
    });
    assert.equal(refreshed.changed, true);
    assert.notEqual(refreshed.version, first.version);
    assert.equal(refreshed.fingerprint, first.fingerprint);
  } finally {
    await fixture.cleanup();
  }
});

test("buildDevPackage uses only the explicit development MCP override", async () => {
  const fixture = await makeTempPlugin();
  try {
    const result = await buildDevPackage({
      pluginRoot: fixture.pluginRoot,
      buildRoot: fixture.buildRoot,
      env: {
        NUANU_MCP_URL: "https://flow.nuanu.com/mcp-server/mcp",
        NUANU_DEV_MCP_URL: "http://127.0.0.1:7654/mcp",
      },
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const manifest = await readJson(
      path.join(result.pluginRoot, ".codex-plugin/plugin.json"),
    );
    assert.equal(manifest.mcpServers.flow_dev.url, "http://127.0.0.1:7654/mcp");
    assert.doesNotMatch(JSON.stringify(manifest.mcpServers.flow_dev), /flow\.nuanu\.com/);
  } finally {
    await fixture.cleanup();
  }
});

test("profileText activates exactly one persistent Nuanu Flow plugin", () => {
  assert.equal(
    profileText("dev"),
    `${PROFILE_MARKER}
[plugins."nuanu-flow@nuanu"]
enabled = false

[plugins."nuanu-flow-dev@nuanu-dev"]
enabled = true
`,
  );
  assert.equal(
    profileText("prod"),
    `${PROFILE_MARKER}
[plugins."nuanu-flow@nuanu"]
enabled = true

[plugins."nuanu-flow-dev@nuanu-dev"]
enabled = false
`,
  );
});

test("writeOwnedProfile creates private files, updates owned files, and rejects unowned files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-profiles-"));
  const profile = path.join(tempRoot, "nested", "nuanu-flow-dev.config.toml");
  const unowned = path.join(tempRoot, "unowned.config.toml");
  try {
    assert.equal(await writeOwnedProfile(profile, profileText("dev")), "created");
    assert.equal(await writeOwnedProfile(profile, profileText("dev")), "unchanged");
    assert.equal(await writeOwnedProfile(profile, profileText("prod")), "updated");
    assert.equal((await fs.stat(path.dirname(profile))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(profile)).mode & 0o777, 0o600);

    await fs.writeFile(unowned, "[plugins]\n");
    await assert.rejects(
      writeOwnedProfile(unowned, profileText("dev")),
      /refusing to overwrite unowned Codex profile/i,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("classifyMarketplace distinguishes this checkout, remote production, and foreign sources", () => {
  assert.equal(
    classifyMarketplace(
      {
        name: "nuanu",
        root: repoRoot,
        marketplaceSource: { sourceType: "local", source: repoRoot },
      },
      repoRoot,
    ),
    "this-checkout",
  );
  assert.equal(
    classifyMarketplace(
      {
        name: "nuanu",
        root: "/cache/nuanu",
        marketplaceSource: {
          sourceType: "git",
          source: "nuanu-ai/agent-tools",
          ref: "main",
        },
      },
      repoRoot,
    ),
    "remote",
  );
  assert.equal(
    classifyMarketplace(
      {
        name: "nuanu",
        root: "/tmp/someone-else",
        marketplaceSource: {
          sourceType: "local",
          source: "/tmp/someone-else",
        },
      },
      repoRoot,
    ),
    "foreign",
  );
});

test("setup migrates this checkout to remote production and installs both identities", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-setup-"));
  const statePath = path.join(tempRoot, "fake-state.json");
  const logPath = path.join(tempRoot, "fake-log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      marketplaces: [
        {
          name: "nuanu",
          root: repoRoot,
          marketplaceSource: { sourceType: "local", source: repoRoot },
        },
      ],
      installed: [],
      mcpAuth: {},
    })}\n`,
  );
  try {
    const report = await setup({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
      },
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(report.dryRun, false);

    const commands = await readCommandLog(logPath);
    assert.deepEqual(commands.slice(0, 2), [
      ["--version"],
      ["plugin", "marketplace", "list", "--json"],
    ]);
    assert(
      commands.some((args) =>
        args.join(" ").includes("plugin marketplace remove nuanu --json"),
      ),
    );
    assert(
      commands.some((args) =>
        args.join(" ").includes(
          "plugin marketplace add nuanu-ai/agent-tools --ref main --json",
        ),
      ),
    );
    assert(
      commands.some(
        (args) =>
          args[0] === "plugin" &&
          args[1] === "marketplace" &&
          args[2] === "add" &&
          args[3] === buildRoot,
      ),
    );
    assert(
      commands.some(
        (args) =>
          args.join(" ") === "plugin add nuanu-flow@nuanu --json",
      ),
    );
    assert(
      commands.some(
        (args) =>
          args.join(" ") === "plugin add nuanu-flow-dev@nuanu-dev --json",
      ),
    );
    assert.equal(
      commands.some(
        (args) => args[0] === "plugin" && args[1] === "remove",
      ),
      false,
    );

    const state = await readJson(statePath);
    assert.equal(
      state.marketplaces.find((entry) => entry.name === "nuanu")
        .marketplaceSource.sourceType,
      "git",
    );
    assert.equal(
      state.marketplaces.find((entry) => entry.name === "nuanu-dev").root,
      buildRoot,
    );
    assert.deepEqual(
      state.installed.map((plugin) => plugin.pluginId).sort(),
      ["nuanu-flow-dev@nuanu-dev", "nuanu-flow@nuanu"],
    );
    assert.equal(
      await fs.readFile(
        path.join(codexHome, "nuanu-flow-prod.config.toml"),
        "utf8",
      ),
      profileText("prod"),
    );
    assert.equal(
      await fs.readFile(
        path.join(codexHome, "nuanu-flow-dev.config.toml"),
        "utf8",
      ),
      profileText("dev"),
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("setup refuses a foreign production marketplace before changing Codex state", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-setup-foreign-"));
  const statePath = path.join(tempRoot, "fake-state.json");
  const logPath = path.join(tempRoot, "fake-log.jsonl");
  const original = {
    marketplaces: [
      {
        name: "nuanu",
        root: "/tmp/foreign-nuanu",
        marketplaceSource: {
          sourceType: "local",
          source: "/tmp/foreign-nuanu",
        },
      },
    ],
    installed: [],
    mcpAuth: {},
  };
  await fs.writeFile(statePath, `${JSON.stringify(original, null, 2)}\n`);
  try {
    await assert.rejects(
      setup({
        repoRoot,
        codexHome: path.join(tempRoot, "codex-home"),
        buildRoot: path.join(tempRoot, "codex-dev"),
        codexBin: fakeCodexBin,
        env: {
          ...process.env,
          FAKE_CODEX_STATE: statePath,
          FAKE_CODEX_LOG: logPath,
        },
      }),
      /foreign marketplace named nuanu/i,
    );
    assert.deepEqual(await readJson(statePath), original);
    const commands = await readCommandLog(logPath);
    assert.deepEqual(commands, [
      ["--version"],
      ["plugin", "marketplace", "list", "--json"],
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("setup dry-run reports actions without changing fake state or profiles", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-setup-dry-"));
  const statePath = path.join(tempRoot, "fake-state.json");
  const logPath = path.join(tempRoot, "fake-log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const original = {
    marketplaces: [],
    installed: [],
    mcpAuth: {},
  };
  await fs.writeFile(statePath, `${JSON.stringify(original, null, 2)}\n`);
  try {
    const report = await setup({
      repoRoot,
      codexHome,
      buildRoot: path.join(tempRoot, "codex-dev"),
      codexBin: fakeCodexBin,
      dryRun: true,
      env: {
        ...process.env,
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
      },
    });
    assert.equal(report.dryRun, true);
    assert.deepEqual(await readJson(statePath), original);
    await assert.rejects(fs.access(codexHome), { code: "ENOENT" });
    assert.deepEqual(await readCommandLog(logPath), [
      ["--version"],
      ["plugin", "marketplace", "list", "--json"],
    ]);
    assert.deepEqual(
      report.actions.map((action) => action.kind),
      [
        "marketplace-add",
        "marketplace-add",
        "plugin-add",
        "plugin-add",
        "profile-write",
        "profile-write",
      ],
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveModeCredentials keeps production and development secrets isolated and redacted", async () => {
  const keychain = {
    async get({ account }) {
      return account === "nuanu-flow-codex-dev" ? "keychain-dev-secret" : null;
    },
  };
  const dev = await resolveModeCredentials(
    "dev",
    {
      PATH: "/usr/bin",
      NUANU_TOKEN: "prod-secret",
      NUANU_AGENT_KEY: "prod-agent-secret",
      NUANU_DEV_TOKEN: "dev-secret",
      NUANU_DEV_AGENT_KEY: "dev-agent-secret",
    },
    keychain,
  );
  assert.equal(dev.env.PATH, "/usr/bin");
  assert.equal(dev.env.NUANU_DEV_TOKEN, "dev-secret");
  assert.equal(dev.env.NUANU_DEV_AGENT_KEY, "dev-agent-secret");
  assert.equal(dev.env.NUANU_TOKEN, undefined);
  assert.equal(dev.env.NUANU_AGENT_KEY, undefined);
  assert.equal(dev.report.source, "environment-token");
  assert.doesNotMatch(JSON.stringify(dev.report), /secret/);

  const prod = await resolveModeCredentials(
    "prod",
    {
      NUANU_TOKEN: "prod-secret",
      NUANU_DEV_TOKEN: "dev-secret",
    },
    keychain,
  );
  assert.equal(prod.env.NUANU_TOKEN, "prod-secret");
  assert.equal(prod.env.NUANU_DEV_TOKEN, undefined);
  assert.equal(prod.report.source, "environment-token");
  assert.doesNotMatch(JSON.stringify(prod.report), /secret/);

  const keychainOnly = await resolveModeCredentials("dev", {}, keychain);
  assert.equal(keychainOnly.env.NUANU_DEV_TOKEN, "keychain-dev-secret");
  assert.equal(keychainOnly.report.source, "keychain");
  assert.doesNotMatch(JSON.stringify(keychainOnly.report), /keychain-dev-secret/);
  assert.equal(keychainAccount("prod"), "nuanu-flow-codex-prod");
  assert.equal(keychainAccount("dev"), "nuanu-flow-codex-dev");
});

test("OAuth metadata classification preserves the existing auth-doctor contract", () => {
  const candidates = metadataCandidates("https://flow.example/mcp-server/mcp");
  assert.deepEqual(candidates, [
    "https://flow.example/.well-known/oauth-protected-resource",
    "https://flow.example/.well-known/oauth-authorization-server",
    "https://flow.example/mcp-server/.well-known/oauth-protected-resource",
    "https://flow.example/mcp-server/.well-known/oauth-authorization-server",
  ]);
  assert.deepEqual(
    classifyOAuthProbes([
      {
        url: candidates[2],
        status: 404,
        json: { error: "oauth_disabled" },
      },
    ]),
    { status: "oauth-disabled", probe: candidates[2] },
  );
});

test("readMcpAuthStatus reads the selected profile and server only", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-auth-status-"));
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "log.jsonl");
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      marketplaces: [],
      installed: [],
      mcpAuth: { flow: "o_auth", flow_dev: "not_logged_in" },
    })}\n`,
  );
  try {
    const env = {
      ...process.env,
      FAKE_CODEX_STATE: statePath,
      FAKE_CODEX_LOG: logPath,
    };
    assert.equal(
      await readMcpAuthStatus("prod", { codexBin: fakeCodexBin, env }),
      "o_auth",
    );
    assert.equal(
      await readMcpAuthStatus("dev", { codexBin: fakeCodexBin, env }),
      "not_logged_in",
    );
    assert.deepEqual(await readCommandLog(logPath), [
      ["--profile", "nuanu-flow-prod", "mcp", "list", "--json"],
      ["--profile", "nuanu-flow-dev", "mcp", "list", "--json"],
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("probeEndpoint distinguishes reachable, timeout, and unreachable endpoints", async () => {
  const fixture = await startHttpFixture((req, res) => {
    if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 100);
      return;
    }
    res.writeHead(401);
    res.end("auth required");
  });
  try {
    const reachable = await probeEndpoint(`${fixture.origin}/mcp`, 100);
    assert.equal(reachable.status, "reachable");
    assert.equal(reachable.httpStatus, 401);

    const timeout = await probeEndpoint(`${fixture.origin}/slow`, 10);
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.url, `${fixture.origin}/slow`);
  } finally {
    await fixture.close();
  }
  const unreachable = await probeEndpoint(`${fixture.origin}/mcp`, 50);
  assert.equal(unreachable.status, "unreachable");
  assert.equal(unreachable.url, `${fixture.origin}/mcp`);
});

test("collectStatus reports selected mode health and auth without exposing credentials", async () => {
  const fixture = await startHttpFixture((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes(".well-known")) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "oauth_disabled" }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
  });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-status-"));
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const env = {
    ...process.env,
    FAKE_CODEX_STATE: statePath,
    FAKE_CODEX_LOG: logPath,
    NUANU_DEV_MCP_URL: `${fixture.origin}/mcp`,
    NUANU_DEV_URL: `${fixture.origin}/api`,
    NUANU_DEV_TOKEN: "status-dev-secret",
    NUANU_TOKEN: "status-prod-secret",
  };
  await fs.writeFile(
    statePath,
    `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
  );
  try {
    await setup({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      env,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const report = await collectStatus({
      mode: "dev",
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      env,
      endpointTimeoutMs: 1000,
    });
    assert.equal(report.mode, "dev");
    assert.equal(report.pluginId, "nuanu-flow-dev@nuanu-dev");
    assert.equal(report.mcpUrl, `${fixture.origin}/mcp`);
    assert.equal(report.apiUrl, `${fixture.origin}/api`);
    assert.equal(report.profile.owned, true);
    assert.equal(report.endpoints.mcp.status, "reachable");
    assert.equal(report.endpoints.api.status, "reachable");
    assert.equal(report.auth.source, "environment-token");
    assert.equal(report.oauth.status, "oauth-disabled");
    assert.match(report.installedVersion, /^0\.1\.0\+codex\.local-/);
    assert.doesNotMatch(JSON.stringify(report), /status-(?:dev|prod)-secret/);
  } finally {
    await fixture.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("development preflight fails on its configured endpoint and never falls back to production", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-preflight-"));
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const env = {
    ...process.env,
    FAKE_CODEX_STATE: statePath,
    FAKE_CODEX_LOG: logPath,
    NUANU_DEV_MCP_URL: "http://127.0.0.1:1/mcp",
  };
  await fs.writeFile(
    statePath,
    `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
  );
  try {
    await setup({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      env,
    });
    await assert.rejects(
      preflight("dev", {
        repoRoot,
        codexHome,
        buildRoot,
        codexBin: fakeCodexBin,
        env,
        endpointTimeoutMs: 20,
      }),
      /http:\/\/127\.0\.0\.1:1\/mcp/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildCodexLaunch selects one profile, one credential namespace, and a visible banner", async () => {
  const dev = await buildCodexLaunch("dev", {
    cwd: "/tmp/nuanu-dev-work",
    codexArgs: ["--no-alt-screen"],
    env: {
      PATH: "/usr/bin",
      NUANU_TOKEN: "prod-token",
      NUANU_DEV_TOKEN: "dev-token",
      NUANU_DEV_MCP_URL: "http://localhost:3001/mcp",
    },
  });
  assert.deepEqual(dev.args, [
    "--profile",
    "nuanu-flow-dev",
    "--no-alt-screen",
  ]);
  assert.equal(dev.cwd, "/tmp/nuanu-dev-work");
  assert.match(dev.banner, /NUANU FLOW LOCAL DEVELOPMENT/);
  assert.match(dev.banner, /http:\/\/localhost:3001\/mcp/);
  assert.equal(dev.env.NUANU_DEV_TOKEN, "dev-token");
  assert.equal(dev.env.NUANU_TOKEN, undefined);

  const prod = await buildCodexLaunch("prod", {
    cwd: "/tmp/nuanu-prod-work",
    env: {
      NUANU_TOKEN: "prod-token",
      NUANU_DEV_TOKEN: "dev-token",
    },
  });
  assert.deepEqual(prod.args, ["--profile", "nuanu-flow-prod"]);
  assert.match(prod.banner, /NUANU FLOW PRODUCTION/);
  assert.match(prod.banner, /https:\/\/flow\.nuanu\.com\/mcp-server\/mcp/);
  assert.equal(prod.env.NUANU_TOKEN, "prod-token");
  assert.equal(prod.env.NUANU_DEV_TOKEN, undefined);
  assert.doesNotMatch(dev.banner + prod.banner, /prod-token|dev-token/);
});

test("parseRunModeArgs preserves Codex args and forced refresh behavior", () => {
  assert.deepEqual(
    parseRunModeArgs([
      "dev",
      "--force-refresh",
      "--no-launch",
      "--cwd",
      "/tmp/project",
      "--",
      "exec",
      "--ephemeral",
      "hello",
    ]),
    {
      mode: "dev",
      forceRefresh: true,
      noLaunch: true,
      dryRun: false,
      cwd: "/tmp/project",
      codexArgs: ["exec", "--ephemeral", "hello"],
      codexBin: "codex",
    },
  );
});

test("buildWorkerLaunch maps development credentials into a child-only App Server environment", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    NUANU_TOKEN: "prod-token",
    NUANU_AGENT_KEY: "prod-agent-key",
    NUANU_DEV_TOKEN: "dev-token",
    NUANU_DEV_AGENT_KEY: "local-agent-key",
    NUANU_DEV_WORKSPACE: "local-workspace",
  };
  const dev = buildWorkerLaunch("dev", {
    cwd: "/tmp/nuanu-worker",
    env: parentEnv,
  });
  assert.equal(
    dev.script,
    path.join(repoRoot, "plugins/nuanu-flow/scripts/worker/worker.mjs"),
  );
  assert.equal(dev.env.NUANU_URL, "http://localhost:8000/api");
  assert.equal(
    dev.env.NUANU_GATEWAY_URL,
    "ws://localhost:3100/live/agent-gateway",
  );
  assert.equal(dev.env.NUANU_AGENT_KEY, "local-agent-key");
  assert.equal(dev.env.NUANU_DEV_AGENT_KEY, "local-agent-key");
  assert.equal(dev.env.NUANU_ADAPTER, "codex-app-server");
  assert.equal(
    dev.env.NUANU_CODEX_APP_SERVER_ARGS,
    "--profile nuanu-flow-dev app-server --stdio",
  );
  assert.equal(dev.env.NUANU_CODEX_AGENT_KEY_ENV, "NUANU_DEV_AGENT_KEY");
  assert.equal(dev.env.NUANU_TOKEN, undefined);
  assert.match(dev.banner, /NUANU FLOW LOCAL DEVELOPMENT WORKER/);
  assert.equal(parentEnv.NUANU_AGENT_KEY, "prod-agent-key");
  assert.equal(parentEnv.NUANU_DEV_AGENT_KEY, "local-agent-key");

  const prod = buildWorkerLaunch("prod", {
    env: {
      NUANU_AGENT_KEY: "prod-agent-key",
      NUANU_DEV_AGENT_KEY: "local-agent-key",
      NUANU_URL: "https://flow.nuanu.com/custom-api",
    },
  });
  assert.equal(prod.env.NUANU_URL, "https://flow.nuanu.com/custom-api");
  assert.equal(prod.env.NUANU_AGENT_KEY, "prod-agent-key");
  assert.equal(prod.env.NUANU_DEV_AGENT_KEY, undefined);
  assert.equal(
    prod.env.NUANU_CODEX_APP_SERVER_ARGS,
    "--profile nuanu-flow-prod app-server --stdio",
  );
  assert.match(prod.banner, /NUANU FLOW PRODUCTION WORKER/);
});

test("buildWorkerLaunch rejects missing keys and production endpoints in development", () => {
  assert.throws(
    () => buildWorkerLaunch("dev", { env: {} }),
    /NUANU_DEV_AGENT_KEY/,
  );
  assert.throws(
    () =>
      buildWorkerLaunch("dev", {
        env: {
          NUANU_DEV_AGENT_KEY: "local-agent-key",
          NUANU_URL: "https://flow.nuanu.com/api",
        },
      }),
    /development worker URL must use localhost/i,
  );
});

test("nextVersion supports release increments and rejects invalid requests", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.0", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.0", "1.4.2"), "1.4.2");
  assert.throws(
    () => nextVersion("0.1.0", "banana"),
    /patch, minor, major/,
  );
  assert.throws(
    () => nextVersion("0.1.0+local", "patch"),
    /canonical semantic version/,
  );
});

test("updateManifestVersion changes only the canonical version and honors dry-run", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-version-"));
  const manifestPath = path.join(tempRoot, "plugin.json");
  const original = {
    name: "nuanu-flow",
    version: "0.1.0",
    description: "fixture",
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
  try {
    const dry = await updateManifestVersion({
      manifestPath,
      request: "minor",
      dryRun: true,
    });
    assert.deepEqual(dry, {
      oldVersion: "0.1.0",
      newVersion: "0.2.0",
      changed: false,
      dryRun: true,
    });
    assert.deepEqual(await readJson(manifestPath), original);

    const written = await updateManifestVersion({
      manifestPath,
      request: "patch",
    });
    assert.deepEqual(written, {
      oldVersion: "0.1.0",
      newVersion: "0.1.1",
      changed: true,
      dryRun: false,
    });
    assert.equal(
      await fs.readFile(manifestPath, "utf8"),
      `{
  "name": "nuanu-flow",
  "version": "0.1.1",
  "description": "fixture"
}
`,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("updateProduction upgrades only Git-backed production without removing the plugin", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-update-"));
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      marketplaces: [
        {
          name: "nuanu",
          root: "/fake/git/nuanu-ai-agent-tools",
          marketplaceSource: {
            sourceType: "git",
            source: "nuanu-ai/agent-tools",
            ref: "main",
          },
        },
      ],
      installed: [
        {
          pluginId: "nuanu-flow@nuanu",
          name: "nuanu-flow",
          marketplaceName: "nuanu",
          version: "0.1.0",
          installed: true,
          enabled: true,
        },
      ],
      mcpAuth: {},
    })}\n`,
  );
  try {
    const report = await updateProduction({
      repoRoot,
      codexHome,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
      },
    });
    assert.equal(report.oldVersion, "0.1.0");
    assert.equal(report.newVersion, "0.1.0");
    assert.equal(report.changed, false);

    const commands = await readCommandLog(logPath);
    const mutations = commands.filter(
      (args) =>
        args[0] === "plugin" &&
        (args[1] === "add" ||
          (args[1] === "marketplace" && args[2] === "upgrade")),
    );
    assert.deepEqual(mutations, [
      ["plugin", "marketplace", "upgrade", "nuanu", "--json"],
      ["plugin", "add", "nuanu-flow@nuanu", "--json"],
    ]);
    assert.equal(commands.some((args) => args.includes("remove")), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("updateProduction refuses a local production marketplace before mutation", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-update-local-"));
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "log.jsonl");
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      marketplaces: [
        {
          name: "nuanu",
          root: repoRoot,
          marketplaceSource: { sourceType: "local", source: repoRoot },
        },
      ],
      installed: [],
      mcpAuth: {},
    })}\n`,
  );
  try {
    await assert.rejects(
      updateProduction({
        repoRoot,
        codexHome: path.join(tempRoot, "codex-home"),
        codexBin: fakeCodexBin,
        env: {
          ...process.env,
          FAKE_CODEX_STATE: statePath,
          FAKE_CODEX_LOG: logPath,
        },
      }),
      /npm run codex:setup/,
    );
    const commands = await readCommandLog(logPath);
    assert.equal(
      commands.some(
        (args) =>
          args.includes("upgrade") ||
          args.includes("add") ||
          args.includes("remove"),
      ),
      false,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
