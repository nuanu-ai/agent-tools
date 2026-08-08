import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildClaudeDevPackage } from "../../scripts/claude/dev-package.mjs";
import { installClaude } from "../../scripts/claude/install.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pluginRoot = path.join(repoRoot, "plugins/nuanu-flow");
const workerPluginRoot = path.join(repoRoot, "plugins/nuanu-flow-worker");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("Claude plugin uses native metadata, MCP OAuth config, hooks, and the shared one-line prompt", async () => {
  const manifest = await readJson(
    path.join(pluginRoot, ".claude-plugin/plugin.json"),
  );
  const codexManifest = await readJson(
    path.join(pluginRoot, ".codex-plugin/plugin.json"),
  );
  const mcp = await readJson(path.join(pluginRoot, ".mcp.json"));
  const hooks = await readJson(path.join(pluginRoot, "hooks/hooks.json"));
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.equal(manifest.name, "nuanu-flow");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, codexManifest.version);
  // Claude auto-discovers hooks/hooks.json. Declaring it again in the manifest
  // makes Claude run BOTH that file and the manifest-named one, so the Codex
  // hook config must never be reachable by auto-discovery.
  assert.equal(manifest.hooks, undefined);
  assert.equal(codexManifest.hooks, "./hooks/codex-hooks.json");
  assert.equal(
    hooks.hooks.SessionStart[0].hooks[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"',
  );
  assert.equal(mcp.mcpServers.mcp.type, "http");
  assert.equal(
    mcp.mcpServers.mcp.url,
    "${NUANU_MCP_URL:-https://flow.nuanu.com/mcp-server/mcp}",
  );
  assert.match(
    readme,
    /Read and install https:\/\/flow\.nuanu\.com\/install\.md/,
  );
  assert.match(readme, /\/reload-plugins/);
  await fs.access(
    path.join(workerPluginRoot, "skills/claude-code-remote-worker/SKILL.md"),
  );
  const workerManifest = await readJson(
    path.join(workerPluginRoot, ".claude-plugin/plugin.json"),
  );
  assert.equal(workerManifest.name, "nuanu-flow-worker");
  await assert.rejects(fs.access(path.join(workerPluginRoot, ".mcp.json")));
});

test("no plugin exposes a Codex-rooted hook config to Claude auto-discovery", async () => {
  for (const root of [pluginRoot, workerPluginRoot]) {
    const manifest = await readJson(
      path.join(root, ".claude-plugin/plugin.json"),
    );
    // Auto-discovery already loads hooks/hooks.json; a manifest key would add a
    // second, duplicate registration.
    assert.equal(
      manifest.hooks,
      undefined,
      `${manifest.name} must not declare a hooks path`,
    );

    // The auto-discovered file is the Claude one and must use Claude's root var.
    const claudeHooks = await readJson(path.join(root, "hooks/hooks.json"));
    const claudeCommands = Object.values(claudeHooks.hooks)
      .flat()
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command);
    assert.ok(claudeCommands.length > 0);
    for (const command of claudeCommands) {
      assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
      assert.doesNotMatch(command, /\$\{PLUGIN_ROOT\}/);
    }

    // The Codex file must exist under a name Claude never auto-discovers.
    const codexHooks = await readJson(path.join(root, "hooks/codex-hooks.json"));
    const codexCommands = Object.values(codexHooks.hooks)
      .flat()
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command);
    for (const command of codexCommands) {
      assert.match(command, /\$\{PLUGIN_ROOT\}/);
    }
    const codexManifest = await readJson(
      path.join(root, ".codex-plugin/plugin.json"),
    );
    assert.equal(codexManifest.hooks, "./hooks/codex-hooks.json");
  }
});

test("Claude development package is isolated and points only to localhost", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-claude-dev-"),
  );
  try {
    const result = await buildClaudeDevPackage({
      buildRoot: path.join(temporary, "claude-dev"),
      env: { NUANU_DEV_MCP_URL: "http://localhost:3001/mcp" },
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    const manifest = await readJson(
      path.join(result.pluginRoot, ".claude-plugin/plugin.json"),
    );
    const mcp = await readJson(path.join(result.pluginRoot, ".mcp.json"));
    const marketplace = await readJson(
      path.join(result.marketplaceRoot, ".claude-plugin/marketplace.json"),
    );
    const workerManifest = await readJson(
      path.join(result.workerPluginRoot, ".claude-plugin/plugin.json"),
    );

    assert.equal(manifest.name, "nuanu-flow-dev");
    assert.match(manifest.displayName, /\[DEV\]/);
    assert.equal(mcp.mcpServers.mcp.url, "http://localhost:3001/mcp");
    assert.equal(
      mcp.mcpServers.mcp.headers["X-Agent-Key"],
      "${NUANU_DEV_AGENT_KEY:-}",
    );
    assert.equal(
      mcp.mcpServers.mcp.headers["X-Agent-Client"],
      "Claude Code [DEV]",
    );
    assert.equal(marketplace.name, "nuanu-dev");
    assert.equal(marketplace.plugins[0].name, "nuanu-flow-dev");
    assert.equal(marketplace.plugins[1].name, "nuanu-flow-worker-dev");
    assert.equal(workerManifest.name, "nuanu-flow-worker-dev");
    await assert.rejects(
      fs.access(path.join(result.workerPluginRoot, ".mcp.json")),
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

function createFakeClaude() {
  const calls = [];
  let marketplaces = [];
  let plugins = [];
  const command = (args) => {
    calls.push(args);
    if (args[0] === "--version") return "2.1.218 (Claude Code)\\n";
    if (args[0] === "auth") return JSON.stringify({ loggedIn: true });
    if (args.join(" ") === "plugin marketplace list --json")
      return JSON.stringify(marketplaces);
    if (args.join(" ") === "plugin list --json") return JSON.stringify(plugins);
    if (
      args[0] === "plugin" &&
      args[1] === "marketplace" &&
      args[2] === "add"
    ) {
      marketplaces = [{ name: "nuanu-dev", path: args[3] }];
      return "";
    }
    if (args[0] === "plugin" && args[1] === "install") {
      const id = args[2];
      plugins = plugins.filter((entry) => entry.id !== id);
      plugins.push({
        id,
        version: "test",
        enabled: true,
        installPath: `/tmp/${id.split("@")[0]}`,
      });
      return "";
    }
    if (args[0] === "plugin" && args[1] === "validate") return "valid";
    if (args[0] === "mcp" && args[1] === "login") return "";
    throw new Error(`Unexpected fake Claude command: ${args.join(" ")}`);
  };
  return { calls, command };
}

test("Claude CLI installer uses native marketplace, plugin, MCP login, and current-session reload", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-claude-install-"),
  );
  const { calls, command } = createFakeClaude();

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
      surface: "claude-code-cli",
      installation: "installed",
      authentication: "connected",
      attachment: "reload_required",
      continuation: "same_conversation_command",
    });
    assert(
      calls.some(
        (args) =>
          args[0] === "plugin" &&
          args[1] === "marketplace" &&
          args[2] === "add",
      ),
    );
    assert(calls.some((args) => args[0] === "plugin" && args[1] === "install"));
    assert.deepEqual(
      calls.find((args) => args[0] === "mcp" && args[1] === "login"),
      ["mcp", "login", "plugin:nuanu-flow-dev:mcp"],
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Claude remote-agent install enables the matched pair and skips human MCP OAuth", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-claude-worker-pair-"),
  );
  const { calls, command } = createFakeClaude();
  try {
    const result = await installClaude("dev", {
      command,
      remoteAgent: true,
      buildRoot: path.join(temporary, "claude-dev"),
      env: { NUANU_DEV_MCP_URL: "http://localhost:3001/mcp" },
    });
    assert.deepEqual(result.pluginIds, [
      "nuanu-flow-dev@nuanu-dev",
      "nuanu-flow-worker-dev@nuanu-dev",
    ]);
    assert.equal(result.auth, "skipped");
    assert.equal(
      calls.filter((args) => args[0] === "mcp" && args[1] === "login")
        .length,
      0,
    );
    assert.equal(
      calls.filter((args) => args[0] === "plugin" && args[1] === "install")
        .length,
      2,
    );
    assert.match(result.nextAction, /Human OAuth and onboarding are not part/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Claude Desktop installer defers auth and attachment to one automatic new Code session", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-claude-desktop-install-"),
  );
  const { calls, command } = createFakeClaude();

  try {
    const result = await installClaude("dev", {
      command,
      surface: "desktop",
      buildRoot: path.join(temporary, "claude-dev"),
      env: { NUANU_DEV_MCP_URL: "http://localhost:3001/mcp" },
    });
    assert.equal(result.surface, "claude-code-desktop");
    assert.equal(result.reloadCommand, null);
    assert.equal(result.auth, "skipped");
    assert.match(
      result.nextAction,
      /Start one new Claude Desktop Code session/,
    );
    assert.match(result.nextAction, /send `Continue Nuanu Flow setup` once/);
    assert.match(result.nextAction, /do not run an onboarding preflight/);
    assert.deepEqual(result.lifecycle, {
      surface: "claude-code-desktop",
      installation: "installed",
      authentication: "skipped",
      attachment: "new_session_required",
      continuation: "new_session",
    });
    assert.equal(
      calls.some((args) => args[0] === "mcp" && args[1] === "login"),
      false,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("non-interactive Claude CLI installation defers OAuth to native /mcp without a pseudo-terminal", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-claude-non-tty-install-"),
  );
  const { calls, command } = createFakeClaude();

  try {
    const result = await installClaude("dev", {
      command,
      interactive: false,
      buildRoot: path.join(temporary, "claude-dev"),
      env: { NUANU_DEV_MCP_URL: "http://localhost:3001/mcp" },
    });
    assert.equal(result.auth, "skipped");
    assert.match(result.nextAction, /authenticate through \/mcp/);
    assert.match(result.nextAction, /Do not manufacture a pseudo-terminal/);
    assert.equal(
      calls.some((args) => args[0] === "mcp" && args[1] === "login"),
      false,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
