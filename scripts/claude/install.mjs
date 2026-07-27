#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  buildClaudeDevPackage,
} from "./dev-package.mjs";

const MODES = {
  prod: {
    pluginId: "nuanu-flow@nuanu",
    marketplace: "nuanu",
    mcpName: "plugin:nuanu-flow:mcp",
    mcpUrl: "https://flow.nuanu.com/mcp-server/mcp",
  },
  dev: {
    pluginId: "nuanu-flow-dev@nuanu-dev",
    marketplace: "nuanu-dev",
    mcpName: "plugin:nuanu-flow-dev:mcp",
    mcpUrl: "http://localhost:3001/mcp",
  },
};

function command(args, options = {}) {
  const result = spawnSync(options.claudeBin || "claude", args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: options.inherit ? undefined : "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `claude ${args.join(" ")} failed (${result.status}): ${String(
        result.stderr || "",
      ).trim()}`,
    );
  }
  return String(result.stdout || "");
}

function json(args, options) {
  return JSON.parse(command(args, options) || "null");
}

function canonicalMarketplace(entry) {
  return (
    entry?.name === "nuanu" &&
    entry?.source === "github" &&
    entry?.repo === "nuanu-ai/agent-tools"
  );
}

function ownedDevMarketplace(entry, buildRoot) {
  if (entry?.name !== "nuanu-dev") return false;
  const candidates = [entry.path, entry.sourcePath, entry.source, entry.repo]
    .filter((value) => typeof value === "string")
    .map((value) => path.resolve(value));
  return candidates.length === 0 || candidates.includes(path.resolve(buildRoot));
}

export async function installClaude(modeName, options = {}) {
  const mode = MODES[modeName];
  if (!mode) throw new Error("Mode must be dev or prod");
  const env = { ...process.env, ...options.env };
  const runner = options.command || command;
  const run = (args, extra = {}) =>
    runner(args, {
      cwd: options.repoRoot || REPO_ROOT,
      env,
      claudeBin: options.claudeBin,
      ...extra,
    });
  const runJson = (args) => JSON.parse(run(args) || "null");
  const version = run(["--version"]).trim();
  const auth = runJson(["auth", "status"]);
  if (!auth?.loggedIn) {
    throw new Error(
      "Claude Code is not signed in. Run `claude auth login`, then retry.",
    );
  }

  let build = null;
  const buildRoot = path.resolve(options.buildRoot || DEFAULT_BUILD_ROOT);
  if (modeName === "dev") {
    build = await buildClaudeDevPackage({
      buildRoot,
      env,
      force: options.force,
    });
  }

  let marketplaces = runJson(["plugin", "marketplace", "list", "--json"]) || [];
  const existingMarketplace = marketplaces.find(
    (entry) => entry.name === mode.marketplace,
  );
  if (
    existingMarketplace &&
    !(
      modeName === "prod"
        ? canonicalMarketplace(existingMarketplace)
        : ownedDevMarketplace(existingMarketplace, buildRoot)
    )
  ) {
    throw new Error(
      `Refusing to replace a non-Nuanu marketplace named ${mode.marketplace}.`,
    );
  }

  let plugins = runJson(["plugin", "list", "--json"]) || [];
  const opposite = modeName === "dev" ? MODES.prod : MODES.dev;
  if (plugins.some((entry) => entry.id === opposite.pluginId)) {
    run(["plugin", "uninstall", opposite.pluginId, "--scope", "user", "--yes"]);
  }

  if (!existingMarketplace) {
    run([
      "plugin",
      "marketplace",
      "add",
      modeName === "dev" ? build.marketplaceRoot : "nuanu-ai/agent-tools",
    ]);
  } else {
    run(["plugin", "marketplace", "update", mode.marketplace]);
  }

  plugins = runJson(["plugin", "list", "--json"]) || [];
  const installed = plugins.find((entry) => entry.id === mode.pluginId);
  if (installed && modeName === "dev" && installed.version !== build.version) {
    run(["plugin", "uninstall", mode.pluginId, "--scope", "user", "--yes"]);
  } else if (installed && modeName === "prod") {
    run(["plugin", "update", mode.pluginId]);
  }
  plugins = runJson(["plugin", "list", "--json"]) || [];
  if (!plugins.some((entry) => entry.id === mode.pluginId)) {
    run(["plugin", "install", mode.pluginId, "--scope", "user"]);
  }

  run(["plugin", "validate", modeName === "dev" ? build.pluginRoot : path.join(REPO_ROOT, "plugins/nuanu-flow")]);
  if (!options.skipAuth) {
    run(["mcp", "login", mode.mcpName], { inherit: true });
  }
  const verified = runJson(["plugin", "list", "--json"]) || [];
  if (!verified.some((entry) => entry.id === mode.pluginId && entry.enabled)) {
    throw new Error(`${mode.pluginId} was not enabled after installation.`);
  }
  return {
    surface: "claude-code",
    mode: modeName,
    version,
    pluginId: mode.pluginId,
    mcpName: mode.mcpName,
    mcpUrl: modeName === "dev" ? build.mcpUrl : mode.mcpUrl,
    auth: options.skipAuth ? "skipped" : "oauth",
    reloadCommand: "/reload-plugins",
    lifecycle: {
      surface: "claude-code",
      plugin: "installed",
      oauth: options.skipAuth ? "skipped" : "connected",
      activation: "reload_required",
      continuation: "same_conversation_command",
    },
  };
}

async function main() {
  const mode = process.argv[2];
  const skipAuth = process.argv.slice(3).includes("--skip-auth");
  const result = await installClaude(mode, { skipAuth });
  console.log(`Claude Code: ${result.version}`);
  console.log(`Plugin: ${result.pluginId}`);
  console.log(`MCP: ${result.mcpUrl}`);
  console.log(`Authentication: ${result.auth}`);
  console.log("Run /reload-plugins in this conversation to activate Nuanu Flow.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[claude-install] ${error.message}`);
    process.exit(1);
  });
}
