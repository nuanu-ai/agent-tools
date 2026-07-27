import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCodexVersion,
  codexModeHome,
  modeConfig,
} from "../../scripts/codex/modes.mjs";
import {
  buildDevPackage,
  fingerprintPlugin,
} from "../../scripts/codex/dev-package.mjs";
import {
  classifyMarketplace,
  ensureSharedCodexAuth,
  setup,
  writeModeMcpConfig,
} from "../../scripts/codex/setup.mjs";
import {
  authenticateMode,
  classifyOAuthProbes,
  keychainAccount,
  metadataCandidates,
  probeEndpoint,
  readMcpAuthStatus,
  resolveModeCredentials,
} from "../../scripts/codex/auth.mjs";
import { collectStatus, preflight } from "../../scripts/codex/status.mjs";
import {
  buildCodexLaunch,
  parseRunModeArgs,
  runMode,
} from "../../scripts/codex/run-mode.mjs";
import { buildWorkerLaunch } from "../../scripts/codex/run-worker.mjs";
import {
  buildCodexPrompt,
  buildPrompt,
  modelTaskEnv,
} from "../../plugins/nuanu-flow/scripts/worker/adapter.mjs";
import {
  nextVersion,
  updateManifestVersion,
} from "../../scripts/codex/version.mjs";
import { updateProduction } from "../../scripts/codex/update.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sourcePluginRoot = path.join(repoRoot, "plugins/nuanu-flow");
const fakeCodexBin = path.join(repoRoot, "tests/fixtures/fake-codex.mjs");

async function makeTempPlugin() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-codex-modes-"),
  );
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  assert.equal(dev.mcpName, "nuanu-flow");
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
  assert.equal(prod.mcpName, "nuanu-flow");
  assert.equal(prod.mcpUrl, "https://flow.nuanu.com/mcp-server/mcp");
  assert.equal(prod.apiUrl, "https://flow.nuanu.com/api");
  assert.equal(prod.tokenEnv, "NUANU_TOKEN");

  assert.throws(() => modeConfig("staging", {}), /Unknown Nuanu Flow mode/);
});

test("codexModeHome gives production and development separate persistent homes", () => {
  const base = "/tmp/nuanu-codex-base";
  assert.equal(
    codexModeHome("prod", { codexHome: base }),
    path.join(base, "nuanu-flow", "prod"),
  );
  assert.equal(
    codexModeHome("dev", { codexHome: base }),
    path.join(base, "nuanu-flow", "dev"),
  );
  assert.equal(
    codexModeHome("dev", {
      env: {
        CODEX_HOME: path.join(base, "nuanu-flow", "prod"),
      },
    }),
    path.join(base, "nuanu-flow", "dev"),
  );
  assert.equal(
    codexModeHome("prod", {
      env: {
        CODEX_HOME: path.join(base, "nuanu-flow", "dev"),
        NUANU_CODEX_BASE_HOME: base,
      },
    }),
    path.join(base, "nuanu-flow", "prod"),
  );
  assert.throws(
    () => codexModeHome("staging", { codexHome: base }),
    /Unknown Nuanu Flow mode/,
  );
});

test("assertCodexVersion enforces the supported Codex baseline", () => {
  assert.doesNotThrow(() => assertCodexVersion("codex-cli 0.145.0"));
  assert.doesNotThrow(() => assertCodexVersion("codex-cli 1.0.0"));
  assert.throws(
    () => assertCodexVersion("codex-cli 0.144.9"),
    /0\.145\.0 or newer/,
  );
  assert.throws(
    () => assertCodexVersion("not-codex"),
    /Could not parse Codex version/,
  );
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
  const manifestPath = path.join(
    fixture.pluginRoot,
    ".codex-plugin/plugin.json",
  );
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const sourceVersion = JSON.parse(originalManifest).version;
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
      new RegExp(
        `^${escapeRegExp(sourceVersion)}\\+codex\\.local-20260725-120000\\.[a-f0-9]{12}$`,
      ),
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
    assert.deepEqual(Object.keys(manifest.mcpServers), ["nuanu-flow"]);
    assert.equal(
      manifest.mcpServers["nuanu-flow"].url,
      "http://localhost:3001/mcp",
    );
    assert.equal(manifest.mcpServers["nuanu-flow"].auth, "oauth");
    assert.equal(
      manifest.mcpServers["nuanu-flow"].env_http_headers["X-Plane-User-Token"],
      "NUANU_DEV_TOKEN",
    );
    assert.equal(
      manifest.mcpServers["nuanu-flow"].env_http_headers["X-Agent-Key"],
      "NUANU_DEV_AGENT_KEY",
    );
    assert.equal(
      manifest.mcpServers["nuanu-flow"].env_http_headers["X-Plane-Workspace"],
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
    assert.equal(marketplace.plugins[0].policy.authentication, "ON_INSTALL");

    const state = await readJson(
      path.join(result.marketplaceRoot, "state.json"),
    );
    assert.equal(state.fingerprint, result.fingerprint);
    assert.equal(state.version, result.version);
    assert.equal(state.formatVersion, 2);
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
    new Date(
      tick++ === 0 ? "2026-07-25T12:00:00.000Z" : "2026-07-25T12:01:00.000Z",
    );
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
    assert.equal(
      manifest.mcpServers["nuanu-flow"].url,
      "http://127.0.0.1:7654/mcp",
    );
    assert.doesNotMatch(
      JSON.stringify(manifest.mcpServers["nuanu-flow"]),
      /flow\.nuanu\.com/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ensureSharedCodexAuth links the normal Codex login without copying it", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-auth-link-"));
  const baseHome = path.join(tempRoot, "base");
  const modeHome = path.join(baseHome, "nuanu-flow", "dev");
  const source = path.join(baseHome, "auth.json");
  try {
    await fs.mkdir(baseHome, { recursive: true });
    await fs.writeFile(source, '{"token":"shared"}\n', { mode: 0o600 });
    assert.equal(await ensureSharedCodexAuth(baseHome, modeHome), "created");
    assert.equal(await ensureSharedCodexAuth(baseHome, modeHome), "unchanged");
    assert.equal(
      await fs.realpath(path.join(modeHome, "auth.json")),
      await fs.realpath(source),
    );
    assert.equal((await fs.stat(modeHome)).mode & 0o777, 0o700);

    const foreignHome = path.join(baseHome, "nuanu-flow", "foreign");
    await fs.mkdir(foreignHome, { recursive: true });
    await fs.writeFile(path.join(foreignHome, "auth.json"), "{}\n");
    await assert.rejects(
      ensureSharedCodexAuth(baseHome, foreignHome),
      /refusing to replace.*auth\.json/i,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("writeModeMcpConfig persists one managed direct MCP without replacing Codex config", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-mcp-config-"),
  );
  const home = path.join(tempRoot, "dev");
  const config = path.join(home, "config.toml");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    config,
    '[plugins."nuanu-flow-dev@nuanu-dev"]\nenabled = true\n',
  );
  try {
    assert.equal(
      await writeModeMcpConfig("dev", home, {
        NUANU_DEV_MCP_URL: "http://127.0.0.1:7654/mcp",
      }),
      "created",
    );
    assert.equal(
      await writeModeMcpConfig("dev", home, {
        NUANU_DEV_MCP_URL: "http://127.0.0.1:7654/mcp",
      }),
      "unchanged",
    );
    const text = await fs.readFile(config, "utf8");
    assert.match(text, /\[plugins\."nuanu-flow-dev@nuanu-dev"\]/);
    assert.match(text, /\[mcp_servers\.nuanu-flow\]/);
    assert.match(text, /url = "http:\/\/127\.0\.0\.1:7654\/mcp"/);
    assert.match(text, /required = true/);
    assert.match(text, /"X-Plane-User-Token" = "NUANU_DEV_TOKEN"/);
    assert.doesNotMatch(text, /flow\.nuanu\.com/);
    assert.equal((text.match(/\[mcp_servers\.nuanu-flow\]/g) || []).length, 1);
    assert.equal((await fs.stat(config)).mode & 0o777, 0o600);

    await fs.writeFile(
      config,
      `${text}\n[mcp_servers.other]\nurl = "http://localhost:9000/mcp"\n`,
    );
    assert.equal(
      await writeModeMcpConfig("dev", home, {
        NUANU_DEV_MCP_URL: "http://127.0.0.1:7655/mcp",
      }),
      "updated",
    );
    const updated = await fs.readFile(config, "utf8");
    assert.match(updated, /http:\/\/127\.0\.0\.1:7655\/mcp/);
    assert.match(updated, /\[mcp_servers\.other\]/);

    await fs.writeFile(
      config,
      '[mcp_servers."nuanu-flow"]\nurl = "http://localhost:4000/mcp"\n',
    );
    await assert.rejects(
      writeModeMcpConfig("dev", home),
      /refusing to replace unmanaged nuanu-flow MCP config/i,
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
        root: "/cache/nuanu-feature",
        marketplaceSource: {
          sourceType: "git",
          source: "nuanu-ai/agent-tools",
          ref: "feature/test",
        },
      },
      repoRoot,
    ),
    "remote-other",
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

test("setup installs production and development into isolated Codex homes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-setup-"));
  const stateDir = path.join(tempRoot, "fake-state");
  const logPath = path.join(tempRoot, "fake-log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  await fs.mkdir(stateDir);
  await fs.writeFile(
    path.join(stateDir, "prod.json"),
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
  await fs.writeFile(
    path.join(stateDir, "dev.json"),
    `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
  );
  try {
    const report = await setup({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        FAKE_CODEX_STATE_DIR: stateDir,
        FAKE_CODEX_LOG: logPath,
      },
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(report.dryRun, false);

    const commands = await readCommandLog(logPath);
    assert.equal(commands.filter((args) => args[0] === "--version").length, 2);
    assert(
      commands.some((args) =>
        args.join(" ").includes("plugin marketplace remove nuanu --json"),
      ),
    );
    assert(
      commands.some((args) =>
        args
          .join(" ")
          .includes(
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
        (args) => args.join(" ") === "plugin add nuanu-flow@nuanu --json",
      ),
    );
    assert(
      commands.some(
        (args) =>
          args.join(" ") === "plugin add nuanu-flow-dev@nuanu-dev --json",
      ),
    );
    assert.equal(
      commands.some((args) => args[0] === "plugin" && args[1] === "remove"),
      false,
    );

    const prodState = await readJson(path.join(stateDir, "prod.json"));
    const devState = await readJson(path.join(stateDir, "dev.json"));
    assert.equal(
      prodState.marketplaces.find((entry) => entry.name === "nuanu")
        .marketplaceSource.sourceType,
      "git",
    );
    assert.equal(
      devState.marketplaces.find((entry) => entry.name === "nuanu-dev").root,
      buildRoot,
    );
    assert.deepEqual(
      prodState.installed.map((plugin) => plugin.pluginId),
      ["nuanu-flow@nuanu"],
    );
    assert.deepEqual(
      devState.installed.map((plugin) => plugin.pluginId),
      ["nuanu-flow-dev@nuanu-dev"],
    );
    assert.equal(report.homes.prod, codexModeHome("prod", { codexHome }));
    assert.equal(report.homes.dev, codexModeHome("dev", { codexHome }));
    assert.equal((await fs.stat(report.homes.prod)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(report.homes.dev)).mode & 0o777, 0o700);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("setup removes checkout-owned legacy registrations from the base Codex home", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-setup-migrate-"),
  );
  const stateDir = path.join(tempRoot, "fake-state");
  const logPath = path.join(tempRoot, "fake-log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  await fs.mkdir(stateDir);
  await fs.writeFile(
    path.join(stateDir, "codex-home.json"),
    `${JSON.stringify({
      marketplaces: [
        {
          name: "nuanu",
          root: repoRoot,
          marketplaceSource: { sourceType: "local", source: repoRoot },
        },
        {
          name: "nuanu-dev",
          root: buildRoot,
          marketplaceSource: { sourceType: "local", source: buildRoot },
        },
      ],
      installed: [
        { pluginId: "nuanu-flow@nuanu" },
        { pluginId: "nuanu-flow-dev@nuanu-dev" },
      ],
      mcpAuth: {},
    })}\n`,
  );
  for (const mode of ["prod", "dev"]) {
    await fs.writeFile(
      path.join(stateDir, `${mode}.json`),
      `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
    );
  }
  try {
    await setup({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        FAKE_CODEX_STATE_DIR: stateDir,
        FAKE_CODEX_LOG: logPath,
      },
    });
    const baseState = await readJson(path.join(stateDir, "codex-home.json"));
    assert.deepEqual(baseState.marketplaces, []);
    assert.deepEqual(baseState.installed, []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("setup refuses a foreign production marketplace before changing Codex state", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-setup-foreign-"),
  );
  const stateDir = path.join(tempRoot, "fake-state");
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
  await fs.mkdir(stateDir);
  await fs.writeFile(
    path.join(stateDir, "prod.json"),
    `${JSON.stringify(original, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "dev.json"),
    `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
  );
  try {
    await assert.rejects(
      setup({
        repoRoot,
        codexHome: path.join(tempRoot, "codex-home"),
        buildRoot: path.join(tempRoot, "codex-dev"),
        codexBin: fakeCodexBin,
        env: {
          ...process.env,
          FAKE_CODEX_STATE_DIR: stateDir,
          FAKE_CODEX_LOG: logPath,
        },
      }),
      /foreign marketplace named nuanu/i,
    );
    assert.deepEqual(
      await readJson(path.join(stateDir, "prod.json")),
      original,
    );
    const commands = await readCommandLog(logPath);
    assert.equal(
      commands.some(
        (args) =>
          args.includes("add") ||
          args.includes("remove") ||
          args.includes("upgrade"),
      ),
      false,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("setup dry-run reports isolated mode actions without creating homes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-setup-dry-"));
  const stateDir = path.join(tempRoot, "fake-state");
  const logPath = path.join(tempRoot, "fake-log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const original = {
    marketplaces: [],
    installed: [],
    mcpAuth: {},
  };
  await fs.mkdir(stateDir);
  await fs.writeFile(
    path.join(stateDir, "prod.json"),
    `${JSON.stringify(original, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "dev.json"),
    `${JSON.stringify(original, null, 2)}\n`,
  );
  try {
    const report = await setup({
      repoRoot,
      codexHome,
      buildRoot: path.join(tempRoot, "codex-dev"),
      codexBin: fakeCodexBin,
      dryRun: true,
      env: {
        ...process.env,
        FAKE_CODEX_STATE_DIR: stateDir,
        FAKE_CODEX_LOG: logPath,
      },
    });
    assert.equal(report.dryRun, true);
    assert.deepEqual(
      await readJson(path.join(stateDir, "prod.json")),
      original,
    );
    assert.deepEqual(await readJson(path.join(stateDir, "dev.json")), original);
    await assert.rejects(fs.access(codexHome), { code: "ENOENT" });
    const commands = await readCommandLog(logPath);
    assert.equal(commands.filter((args) => args[0] === "--version").length, 2);
    assert.equal(
      commands.filter(
        (args) => args.join(" ") === "plugin marketplace list --json",
      ).length,
      0,
    );
    assert.deepEqual(
      report.actions.map((action) => [action.mode, action.kind]),
      [
        ["prod", "marketplace-add"],
        ["prod", "plugin-add"],
        ["prod", "mcp-config-write"],
        ["dev", "marketplace-add"],
        ["dev", "plugin-add"],
        ["dev", "mcp-config-write"],
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
  assert.doesNotMatch(
    JSON.stringify(keychainOnly.report),
    /keychain-dev-secret/,
  );
  assert.equal(keychainAccount("prod"), "nuanu-flow-codex-prod");
  assert.equal(keychainAccount("dev"), "nuanu-flow-codex-dev");
});

test("interactive authentication delegates profile-scoped browser OAuth to Codex and verifies it", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-browser-oauth-"),
  );
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  await fs.mkdir(stateDir);
  await fs.writeFile(
    path.join(stateDir, "dev.json"),
    `${JSON.stringify({
      marketplaces: [],
      installed: [{ pluginId: "nuanu-flow-dev@nuanu-dev" }],
      mcpAuth: { "nuanu-flow": "not_logged_in" },
    })}\n`,
  );
  try {
    let wrapperBrowserOpenAttempts = 0;
    const result = await authenticateMode("dev", {
      codexHome,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        FAKE_CODEX_STATE_DIR: stateDir,
        FAKE_CODEX_LOG: logPath,
        FAKE_EXPECT_CODEX_HOME: path.join(codexHome, "nuanu-flow", "dev"),
      },
      keychain: {
        get: async () => null,
      },
      openBrowser: () => {
        wrapperBrowserOpenAttempts += 1;
        return true;
      },
    });
    assert.deepEqual(result, { mode: "dev", ready: true, source: "oauth" });
    assert.equal(wrapperBrowserOpenAttempts, 0);
    assert.deepEqual(await readCommandLog(logPath), [
      ["mcp", "list", "--json"],
      ["mcp", "login", "nuanu-flow"],
      ["mcp", "list", "--json"],
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("authentication check reports OAuth readiness without opening the browser", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-oauth-check-"),
  );
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  await fs.mkdir(stateDir);
  await fs.writeFile(
    path.join(stateDir, "prod.json"),
    `${JSON.stringify({
      marketplaces: [],
      installed: [{ pluginId: "nuanu-flow@nuanu" }],
      mcpAuth: { "nuanu-flow": "not_logged_in" },
    })}\n`,
  );
  try {
    const result = await authenticateMode("prod", {
      check: true,
      codexHome,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        FAKE_CODEX_STATE_DIR: stateDir,
        FAKE_CODEX_LOG: logPath,
      },
      keychain: {
        get: async () => null,
      },
    });
    assert.deepEqual(result, {
      mode: "prod",
      ready: false,
      source: "oauth-required",
    });
    assert.deepEqual(await readCommandLog(logPath), [
      ["mcp", "list", "--json"],
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
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

test("readMcpAuthStatus reads the selected isolated home and server only", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-auth-status-"),
  );
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  await fs.mkdir(stateDir);
  await fs.writeFile(
    path.join(stateDir, "prod.json"),
    `${JSON.stringify({
      marketplaces: [],
      installed: [{ pluginId: "nuanu-flow@nuanu" }],
      mcpAuth: { "nuanu-flow": "o_auth" },
    })}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "dev.json"),
    `${JSON.stringify({
      marketplaces: [],
      installed: [{ pluginId: "nuanu-flow-dev@nuanu-dev" }],
      mcpAuth: { "nuanu-flow": "not_logged_in" },
    })}\n`,
  );
  try {
    const env = {
      ...process.env,
      FAKE_CODEX_STATE_DIR: stateDir,
      FAKE_CODEX_LOG: logPath,
    };
    assert.equal(
      await readMcpAuthStatus("prod", {
        codexHome,
        codexBin: fakeCodexBin,
        env,
      }),
      "o_auth",
    );
    assert.equal(
      await readMcpAuthStatus("dev", {
        codexHome,
        codexBin: fakeCodexBin,
        env,
      }),
      "not_logged_in",
    );
    assert.deepEqual(await readCommandLog(logPath), [
      ["mcp", "list", "--json"],
      ["mcp", "list", "--json"],
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
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const env = {
    ...process.env,
    FAKE_CODEX_STATE_DIR: stateDir,
    FAKE_CODEX_LOG: logPath,
    NUANU_DEV_MCP_URL: `${fixture.origin}/mcp`,
    NUANU_DEV_URL: `${fixture.origin}/api`,
    NUANU_DEV_TOKEN: "status-dev-secret",
    NUANU_TOKEN: "status-prod-secret",
  };
  await fs.mkdir(stateDir);
  for (const mode of ["prod", "dev"]) {
    await fs.writeFile(
      path.join(stateDir, `${mode}.json`),
      `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
    );
  }
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
    assert.equal(report.codexHome, codexModeHome("dev", { codexHome }));
    assert.equal(report.isolated, true);
    assert.equal(report.endpoints.mcp.status, "reachable");
    assert.equal(report.endpoints.api.status, "reachable");
    assert.equal(report.auth.source, "environment-token");
    assert.equal(report.oauth.status, "oauth-disabled");
    const sourceVersion = (
      await readJson(path.join(sourcePluginRoot, ".codex-plugin/plugin.json"))
    ).version;
    assert.match(
      report.installedVersion,
      new RegExp(`^${escapeRegExp(sourceVersion)}\\+codex\\.local-`),
    );
    assert.doesNotMatch(JSON.stringify(report), /status-(?:dev|prod)-secret/);
  } finally {
    await fixture.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("development preflight fails on its configured endpoint and never falls back to production", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-preflight-"));
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const env = {
    ...process.env,
    FAKE_CODEX_STATE_DIR: stateDir,
    FAKE_CODEX_LOG: logPath,
    NUANU_DEV_MCP_URL: "http://127.0.0.1:1/mcp",
  };
  await fs.mkdir(stateDir);
  for (const mode of ["prod", "dev"]) {
    await fs.writeFile(
      path.join(stateDir, `${mode}.json`),
      `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
    );
  }
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

test("buildCodexLaunch selects one Codex home, one credential namespace, and a visible banner", async () => {
  const codexHome = "/tmp/nuanu-codex-base";
  const dev = await buildCodexLaunch("dev", {
    codexHome,
    cwd: "/tmp/nuanu-dev-work",
    codexArgs: ["--no-alt-screen"],
    env: {
      PATH: "/usr/bin",
      NUANU_TOKEN: "prod-token",
      NUANU_DEV_TOKEN: "dev-token",
      NUANU_DEV_MCP_URL: "http://localhost:3001/mcp",
    },
  });
  assert.deepEqual(dev.args, ["--no-alt-screen"]);
  assert.equal(dev.cwd, "/tmp/nuanu-dev-work");
  assert.match(dev.banner, /NUANU FLOW LOCAL DEVELOPMENT/);
  assert.match(dev.banner, /http:\/\/localhost:3001\/mcp/);
  assert.equal(dev.env.NUANU_DEV_TOKEN, "dev-token");
  assert.equal(dev.env.NUANU_TOKEN, undefined);
  assert.equal(dev.env.CODEX_HOME, path.join(codexHome, "nuanu-flow", "dev"));
  assert.equal(dev.env.NUANU_CODEX_BASE_HOME, codexHome);

  const prod = await buildCodexLaunch("prod", {
    codexHome,
    cwd: "/tmp/nuanu-prod-work",
    env: {
      NUANU_TOKEN: "prod-token",
      NUANU_DEV_TOKEN: "dev-token",
    },
  });
  assert.deepEqual(prod.args, []);
  assert.match(prod.banner, /NUANU FLOW PRODUCTION/);
  assert.match(prod.banner, /https:\/\/flow\.nuanu\.com\/mcp-server\/mcp/);
  assert.equal(prod.env.NUANU_TOKEN, "prod-token");
  assert.equal(prod.env.NUANU_DEV_TOKEN, undefined);
  assert.equal(prod.env.CODEX_HOME, path.join(codexHome, "nuanu-flow", "prod"));
  assert.equal(prod.env.NUANU_CODEX_BASE_HOME, codexHome);
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

test("runMode preflights the selected home without nesting it twice", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-run-mode-"));
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "log.jsonl");
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const fixture = await startHttpFixture((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(req.url.includes(".well-known") ? 404 : 200);
    res.end(
      JSON.stringify(
        req.url.includes(".well-known")
          ? { error: "oauth_disabled" }
          : { status: "ok" },
      ),
    );
  });
  const env = {
    ...process.env,
    FAKE_CODEX_STATE_DIR: stateDir,
    FAKE_CODEX_LOG: logPath,
    NUANU_DEV_MCP_URL: `${fixture.origin}/mcp`,
    NUANU_DEV_URL: `${fixture.origin}/api`,
  };
  await fs.mkdir(stateDir);
  for (const name of ["codex-home", "prod", "dev"]) {
    await fs.writeFile(
      path.join(stateDir, `${name}.json`),
      `${JSON.stringify({ marketplaces: [], installed: [], mcpAuth: {} })}\n`,
    );
  }
  try {
    await setup({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      env,
    });
    assert.equal(
      await runMode({
        mode: "dev",
        noLaunch: true,
        forceRefresh: false,
        dryRun: false,
        cwd: repoRoot,
        codexArgs: [],
        codexBin: fakeCodexBin,
        repoRoot,
        codexHome,
        buildRoot,
        env: {
          ...env,
          FAKE_EXPECT_CODEX_HOME: codexModeHome("dev", { codexHome }),
        },
      }),
      0,
    );
  } finally {
    await fixture.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
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
    codexHome: "/tmp/codex-base",
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
  assert.equal(dev.env.NUANU_CODEX_APP_SERVER_ARGS, "app-server --stdio");
  assert.equal(dev.env.CODEX_HOME, "/tmp/codex-base/nuanu-flow/dev");
  assert.equal(dev.env.NUANU_CODEX_BASE_HOME, "/tmp/codex-base");
  assert.equal(dev.env.NUANU_CODEX_AGENT_KEY_ENV, "NUANU_DEV_AGENT_KEY");
  assert.equal(dev.env.NUANU_TOKEN, undefined);
  assert.equal(dev.env.NUANU_DEV_TOKEN, undefined);
  assert.match(dev.banner, /NUANU FLOW LOCAL DEVELOPMENT WORKER/);
  assert.equal(parentEnv.NUANU_AGENT_KEY, "prod-agent-key");
  assert.equal(parentEnv.NUANU_DEV_AGENT_KEY, "local-agent-key");

  const prod = buildWorkerLaunch("prod", {
    codexHome: "/tmp/codex-base",
    env: {
      NUANU_AGENT_KEY: "prod-agent-key",
      NUANU_DEV_AGENT_KEY: "local-agent-key",
      NUANU_URL: "https://flow.nuanu.com/custom-api",
    },
  });
  assert.equal(prod.env.NUANU_URL, "https://flow.nuanu.com/custom-api");
  assert.equal(prod.env.NUANU_AGENT_KEY, "prod-agent-key");
  assert.equal(prod.env.NUANU_DEV_AGENT_KEY, undefined);
  assert.equal(prod.env.NUANU_CODEX_APP_SERVER_ARGS, "app-server --stdio");
  assert.equal(prod.env.CODEX_HOME, "/tmp/codex-base/nuanu-flow/prod");
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
  assert.throws(
    () =>
      buildWorkerLaunch("prod", {
        env: {
          NUANU_AGENT_KEY: "prod-agent-key",
          NUANU_URL: "https://example.com/api",
        },
      }),
    /production worker URL must use https:\/\/flow\.nuanu\.com/i,
  );
  assert.throws(
    () =>
      buildWorkerLaunch("prod", {
        env: {
          NUANU_AGENT_KEY: "prod-agent-key",
          NUANU_GATEWAY_URL: "wss://example.com/live/agent-gateway",
        },
      }),
    /production worker gateway URL must use wss:\/\/flow\.nuanu\.com/i,
  );
});

test("modelTaskEnv exposes only the short-lived task key to Codex", () => {
  assert.throws(
    () => modelTaskEnv({}, "NUANU_DEV_AGENT_KEY", {}),
    /short-lived agent_key/,
  );
  const env = modelTaskEnv(
    { agent_key: "per-task-key" },
    "NUANU_DEV_AGENT_KEY",
    {
      PATH: "/usr/bin",
      NUANU_TOKEN: "interactive-prod-token",
      NUANU_DEV_TOKEN: "interactive-dev-token",
      NUANU_AGENT_KEY: "durable-prod-key",
      NUANU_DEV_AGENT_KEY: "durable-dev-key",
    },
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NUANU_DEV_AGENT_KEY, "per-task-key");
  assert.equal(env.NUANU_AGENT_KEY, undefined);
  assert.equal(env.NUANU_TOKEN, undefined);
  assert.equal(env.NUANU_DEV_TOKEN, undefined);
});

test("Codex worker prompts explain deferred MCP tool discovery", () => {
  const task = { instruction: "Call flow_dev_identity." };
  assert.doesNotMatch(buildPrompt(task), /tool_search/);
  assert.match(buildCodexPrompt(task), /tool_search/);
  assert.match(buildCodexPrompt(task), /Call flow_dev_identity/);
});

test("nextVersion supports release increments and rejects invalid requests", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.0", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.0", "1.4.2"), "1.4.2");
  assert.throws(() => nextVersion("0.1.0", "banana"), /patch, minor, major/);
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
    assert.equal(
      commands.some((args) => args.includes("remove")),
      false,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("updateProduction refuses a local production marketplace before mutation", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-update-local-"),
  );
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

test("updateProduction refuses a production marketplace not pinned to main", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-update-ref-"),
  );
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "log.jsonl");
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
            ref: "feature/test",
          },
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
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("generated development validation rejects any production MCP endpoint", async () => {
  const fixture = await makeTempPlugin();
  try {
    const result = await buildDevPackage({
      pluginRoot: fixture.pluginRoot,
      buildRoot: fixture.buildRoot,
      env: {},
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const marketplacePath = path.join(
      result.marketplaceRoot,
      ".agents/plugins/marketplace.json",
    );
    const validate = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/validate-plugins.mjs",
          "--codex-plugin",
          result.pluginRoot,
          "--codex-marketplace",
          marketplacePath,
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );

    const valid = validate();
    assert.equal(valid.status, 0, valid.stderr);

    const manifestPath = path.join(
      result.pluginRoot,
      ".codex-plugin/plugin.json",
    );
    const manifest = await readJson(manifestPath);
    manifest.mcpServers["nuanu-flow"].url =
      "https://flow.nuanu.com/mcp-server/mcp";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const invalid = validate();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /development MCP.*localhost|loopback/i);
  } finally {
    await fixture.cleanup();
  }
});
