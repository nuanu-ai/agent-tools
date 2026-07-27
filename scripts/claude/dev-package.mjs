#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprintPlugin } from "../codex/dev-package.mjs";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DEFAULT_BUILD_ROOT = path.join(REPO_ROOT, ".build/claude-dev");
const SOURCE_PLUGIN_ROOT = path.join(REPO_ROOT, "plugins/nuanu-flow");
const FORMAT_VERSION = 1;

function localMcpUrl(env) {
  const raw = env.NUANU_DEV_MCP_URL || "http://localhost:3001/mcp";
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
  ) {
    throw new Error(`Claude development MCP URL must use loopback HTTP: ${raw}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function timestamp(date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/[-:T]/g, (character) => (character === "T" ? "-" : ""));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function replaceDirectory(temporary, destination) {
  const backup = `${destination}.backup-${process.pid}-${Date.now()}`;
  let hadDestination = false;
  try {
    await fs.rename(destination, backup);
    hadDestination = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(temporary, destination);
    if (hadDestination) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadDestination) await fs.rename(backup, destination);
    throw error;
  }
}

export async function buildClaudeDevPackage(options = {}) {
  const sourceRoot = options.pluginRoot || SOURCE_PLUGIN_ROOT;
  const buildRoot = path.resolve(options.buildRoot || DEFAULT_BUILD_ROOT);
  const mcpUrl = localMcpUrl(options.env || process.env);
  const fingerprint = await fingerprintPlugin(sourceRoot);
  const statePath = path.join(buildRoot, "state.json");
  const generatedRoot = path.join(buildRoot, "plugins/nuanu-flow-dev");
  let state = null;
  try {
    state = await readJson(statePath);
  } catch {
    // First build.
  }
  if (
    !options.force &&
    state?.formatVersion === FORMAT_VERSION &&
    state?.fingerprint === fingerprint &&
    state?.mcpUrl === mcpUrl &&
    (await exists(path.join(generatedRoot, ".claude-plugin/plugin.json")))
  ) {
    return {
      changed: false,
      fingerprint,
      version: state.version,
      marketplaceRoot: buildRoot,
      pluginRoot: generatedRoot,
      mcpUrl,
    };
  }

  const sourceManifest = await readJson(
    path.join(sourceRoot, ".claude-plugin/plugin.json"),
  );
  const sourceMcp = await readJson(path.join(sourceRoot, ".mcp.json"));
  const now = (options.now || (() => new Date()))();
  const baseVersion = String(sourceManifest.version || "0.3.0").split("+")[0];
  const version = `${baseVersion}+claude.local-${timestamp(now)}.${fingerprint.slice(0, 12)}`;
  const temporary = path.join(
    path.dirname(buildRoot),
    `.${path.basename(buildRoot)}.tmp-${process.pid}-${Date.now()}`,
  );
  const temporaryPlugin = path.join(temporary, "plugins/nuanu-flow-dev");

  await fs.mkdir(path.dirname(buildRoot), { recursive: true });
  await fs.rm(temporary, { recursive: true, force: true });
  try {
    await fs.cp(sourceRoot, temporaryPlugin, {
      recursive: true,
      preserveTimestamps: true,
    });
    await fs.writeFile(
      path.join(temporaryPlugin, ".claude-plugin/plugin.json"),
      `${JSON.stringify(
        {
          ...sourceManifest,
          name: "nuanu-flow-dev",
          version,
          displayName: "Nuanu Flow [DEV]",
          description:
            "Local-development Nuanu Flow tools, skills, hooks, OAuth, and remote workers for Claude Code.",
        },
        null,
        2,
      )}\n`,
    );
    const server = sourceMcp?.mcpServers?.mcp;
    if (!server) throw new Error("Claude MCP config must define mcpServers.mcp");
    await fs.writeFile(
      path.join(temporaryPlugin, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            mcp: {
              ...server,
              url: mcpUrl,
              headers: {
                "X-Plane-User-Token": "${NUANU_DEV_TOKEN:-}",
                "X-Agent-Key": "${NUANU_DEV_AGENT_KEY:-}",
                "X-Plane-Workspace": "${NUANU_DEV_WORKSPACE:-}",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.mkdir(path.join(temporary, ".claude-plugin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(temporary, ".claude-plugin/marketplace.json"),
      `${JSON.stringify(
        {
          name: "nuanu-dev",
          owner: { name: "Nuanu" },
          plugins: [
            {
              name: "nuanu-flow-dev",
              source: "./plugins/nuanu-flow-dev",
              description: "Local Nuanu Flow development plugin for Claude Code.",
              category: "productivity",
              tags: ["nuanu-flow", "mcp", "development"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(temporary, "state.json"),
      `${JSON.stringify(
        {
          formatVersion: FORMAT_VERSION,
          fingerprint,
          mcpUrl,
          version,
          generatedAt: now.toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    await replaceDirectory(temporary, buildRoot);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }

  return {
    changed: true,
    fingerprint,
    version,
    marketplaceRoot: buildRoot,
    pluginRoot: generatedRoot,
    mcpUrl,
  };
}

async function main() {
  const force = process.argv.slice(2).includes("--force");
  const result = await buildClaudeDevPackage({ force });
  console.log(
    `${result.changed ? "Built" : "Reused"} ${result.pluginRoot} (${result.version})`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[claude-dev-package] ${error.message}`);
    process.exit(1);
  });
}
