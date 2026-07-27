#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUILD_ROOT, REPO_ROOT } from "./dev-package.mjs";

const PLUGINS = ["nuanu-flow-dev@nuanu-dev", "nuanu-flow@nuanu"];
const MARKETPLACES = ["nuanu-dev", "nuanu"];
const MCP_SERVERS = ["plugin:nuanu-flow-dev:mcp", "plugin:nuanu-flow:mcp"];

function run(args, options = {}) {
  const result = spawnSync(options.claudeBin || "claude", args, {
    cwd: REPO_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

export async function removeClaude(options = {}) {
  const runner = options.run || run;
  const actions = [];
  const pluginsResult = runner(["plugin", "list", "--json"], options);
  const marketplacesResult = runner(
    ["plugin", "marketplace", "list", "--json"],
    options,
  );
  const plugins =
    pluginsResult.status === 0 ? JSON.parse(pluginsResult.stdout || "[]") : [];
  const marketplaces =
    marketplacesResult.status === 0
      ? JSON.parse(marketplacesResult.stdout || "[]")
      : [];

  for (const server of MCP_SERVERS) {
    const result = runner(["mcp", "logout", server], options);
    if (result.status === 0) actions.push(`logged out ${server}`);
  }
  for (const plugin of PLUGINS) {
    if (!plugins.some((entry) => entry.id === plugin)) continue;
    const result = runner(
      ["plugin", "uninstall", plugin, "--scope", "user", "--yes"],
      options,
    );
    if (result.status !== 0) throw new Error(result.stderr.trim());
    actions.push(`removed ${plugin}`);
  }
  for (const marketplace of MARKETPLACES) {
    if (!marketplaces.some((entry) => entry.name === marketplace)) continue;
    const result = runner(
      ["plugin", "marketplace", "remove", marketplace],
      options,
    );
    if (result.status !== 0) throw new Error(result.stderr.trim());
    actions.push(`removed ${marketplace} marketplace`);
  }

  const buildRoot = path.resolve(options.buildRoot || DEFAULT_BUILD_ROOT);
  if (path.basename(buildRoot) !== "claude-dev") {
    throw new Error(`Refusing unexpected Claude build path: ${buildRoot}`);
  }
  await fs.rm(buildRoot, { recursive: true, force: true });
  actions.push("removed generated Claude development package");
  return actions;
}

async function main() {
  const actions = await removeClaude();
  console.log(actions.length ? actions.join("\n") : "Claude Nuanu Flow was already clean.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[claude-remove] ${error.message}`);
    process.exit(1);
  });
}
