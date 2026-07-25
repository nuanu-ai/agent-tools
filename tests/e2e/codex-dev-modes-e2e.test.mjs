import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePluginRoot = path.join(repoRoot, "plugins/nuanu-flow");

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
