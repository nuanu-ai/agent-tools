import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildClaudeDevPackage } from "../../scripts/claude/dev-package.mjs";
import { installClaude } from "../../scripts/claude/install.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repoRoot, "plugins/nuanu-flow");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("Claude plugin uses native metadata, MCP OAuth config, hooks, and the shared one-line prompt", async () => {
  const manifest = await readJson(path.join(pluginRoot, ".claude-plugin/plugin.json"));
  const codexManifest = await readJson(path.join(pluginRoot, ".codex-plugin/plugin.json"));
  const mcp = await readJson(path.join(pluginRoot, ".mcp.json"));
  const hooks = await readJson(path.join(pluginRoot, "hooks/claude-hooks.json"));
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.equal(manifest.name, "nuanu-flow");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, codexManifest.version);
  assert.equal(manifest.hooks, "./hooks/claude-hooks.json");
  assert.equal(
    hooks.hooks.SessionStart[0].hooks[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"'
  );
  assert.equal(mcp.mcpServers.mcp.type, "http");
  assert.equal(mcp.mcpServers.mcp.url, "${NUANU_MCP_URL:-https://flow.nuanu.com/mcp-server/mcp}");
  assert.match(readme, /Read and install https:\/\/flow\.nuanu\.com\/install\.md/);
  assert.match(readme, /\/reload-plugins/);
  await fs.access(path.join(pluginRoot, "skills/claude-code-remote-worker/SKILL.md"));
});

test("Claude development package is isolated and points only to localhost", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-claude-dev-"));
  try {
    const result = await buildClaudeDevPackage({
      buildRoot: path.join(temporary, "claude-dev"),
      env: { NUANU_DEV_MCP_URL: "http://localhost:3001/mcp" },
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    const manifest = await readJson(path.join(result.pluginRoot, ".claude-plugin/plugin.json"));
    const mcp = await readJson(path.join(result.pluginRoot, ".mcp.json"));
    const marketplace = await readJson(
      path.join(result.marketplaceRoot, ".claude-plugin/marketplace.json")
    );

    assert.equal(manifest.name, "nuanu-flow-dev");
    assert.match(manifest.displayName, /\[DEV\]/);
    assert.equal(mcp.mcpServers.mcp.url, "http://localhost:3001/mcp");
    assert.equal(mcp.mcpServers.mcp.headers["X-Agent-Key"], "${NUANU_DEV_AGENT_KEY:-}");
    assert.equal(marketplace.name, "nuanu-dev");
    assert.equal(marketplace.plugins[0].name, "nuanu-flow-dev");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Claude local installer uses native marketplace, plugin, MCP login, and current-session reload", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-claude-install-"));
  const calls = [];
  let marketplaces = [];
  let plugins = [];
  const command = (args) => {
    calls.push(args);
    if (args[0] === "--version") return "2.1.218 (Claude Code)\\n";
    if (args[0] === "auth") return JSON.stringify({ loggedIn: true });
    if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify(marketplaces);
    if (args.join(" ") === "plugin list --json") return JSON.stringify(plugins);
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
      marketplaces = [{ name: "nuanu-dev", path: args[3] }];
      return "";
    }
    if (args[0] === "plugin" && args[1] === "install") {
      plugins = [
        {
          id: "nuanu-flow-dev@nuanu-dev",
          version: "test",
          enabled: true,
          installPath: "/tmp/nuanu-flow-dev",
        },
      ];
      return "";
    }
    if (args[0] === "plugin" && args[1] === "validate") return "valid";
    if (args[0] === "mcp" && args[1] === "login") return "";
    throw new Error(`Unexpected fake Claude command: ${args.join(" ")}`);
  };

  try {
    const result = await installClaude("dev", {
      command,
      buildRoot: path.join(temporary, "claude-dev"),
      env: { NUANU_DEV_MCP_URL: "http://localhost:3001/mcp" },
    });
    assert.equal(result.pluginId, "nuanu-flow-dev@nuanu-dev");
    assert.equal(result.mcpName, "plugin:nuanu-flow-dev:mcp");
    assert.equal(result.reloadCommand, "/reload-plugins");
    assert.deepEqual(result.lifecycle, {
      surface: "claude-code",
      plugin: "installed",
      oauth: "connected",
      activation: "reload_required",
      continuation: "same_conversation_command",
    });
    assert(calls.some((args) => args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add"));
    assert(calls.some((args) => args[0] === "plugin" && args[1] === "install"));
    assert.deepEqual(
      calls.find((args) => args[0] === "mcp" && args[1] === "login"),
      ["mcp", "login", "plugin:nuanu-flow-dev:mcp"]
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
