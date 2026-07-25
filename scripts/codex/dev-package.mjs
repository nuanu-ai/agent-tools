#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  modeConfig,
  readJson,
} from "./modes.mjs";

const DEFAULT_PLUGIN_ROOT = path.join(REPO_ROOT, "plugins/nuanu-flow");

async function walkFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".DS_Store") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolute)));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

export async function fingerprintPlugin(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const hash = crypto.createHash("sha256");
  for (const file of await walkFiles(pluginRoot)) {
    const stat = await fs.lstat(file);
    const relative = path.relative(pluginRoot, file).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(String(stat.mode & 0o777));
    hash.update("\0");
    if (stat.isSymbolicLink()) {
      hash.update(await fs.readlink(file));
    } else {
      hash.update(await fs.readFile(file));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function utcStamp(date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/[-:T]/g, (character) => (character === "T" ? "-" : ""));
}

function assertLocalMcpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Development MCP URL is invalid: ${rawUrl}`);
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error(
      `Development MCP URL must use localhost or loopback, received ${rawUrl}`,
    );
  }
}

function developmentManifest(source, { version, mcpUrl }) {
  const sourceMcp = source.mcpServers?.flow;
  if (!sourceMcp) {
    throw new Error("Production Codex manifest must define mcpServers.flow");
  }
  return {
    ...source,
    name: "nuanu-flow-dev",
    version,
    mcpServers: {
      flow_dev: {
        ...sourceMcp,
        url: mcpUrl,
        env_http_headers: {
          "X-Plane-User-Token": "NUANU_DEV_TOKEN",
          "X-Agent-Key": "NUANU_DEV_AGENT_KEY",
          "X-Plane-Workspace": "NUANU_DEV_WORKSPACE",
        },
      },
    },
    interface: {
      ...source.interface,
      displayName: "Nuanu Flow [DEV]",
      shortDescription:
        "Local development Nuanu Flow MCP tools, skills, and worker support.",
      longDescription:
        "Develop and test Nuanu Flow locally with an isolated Codex plugin identity, localhost MCP configuration, development-only credentials, domain skills, and App Server worker support.",
    },
  };
}

function developmentMarketplace() {
  return {
    name: "nuanu-dev",
    interface: {
      displayName: "Nuanu Development",
    },
    plugins: [
      {
        name: "nuanu-flow-dev",
        source: {
          source: "local",
          path: "./plugins/nuanu-flow-dev",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_USE",
        },
        category: "Productivity",
      },
    ],
  };
}

async function outputExists(buildRoot) {
  try {
    await Promise.all([
      fs.access(
        path.join(
          buildRoot,
          "plugins/nuanu-flow-dev/.codex-plugin/plugin.json",
        ),
      ),
      fs.access(path.join(buildRoot, ".agents/plugins/marketplace.json")),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function replaceDirectory(tempRoot, buildRoot) {
  const backupRoot = `${buildRoot}.backup-${process.pid}-${Date.now()}`;
  let hadPrevious = false;
  try {
    await fs.rename(buildRoot, backupRoot);
    hadPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(tempRoot, buildRoot);
    if (hadPrevious) {
      await fs.rm(backupRoot, { recursive: true, force: true });
    }
  } catch (error) {
    if (hadPrevious) await fs.rename(backupRoot, buildRoot);
    throw error;
  }
}

export async function buildDevPackage(options = {}) {
  const pluginRoot = options.pluginRoot || DEFAULT_PLUGIN_ROOT;
  const buildRoot = options.buildRoot || DEFAULT_BUILD_ROOT;
  const mode = modeConfig("dev", options.env || process.env);
  assertLocalMcpUrl(mode.mcpUrl);

  const sourceManifestPath = path.join(
    pluginRoot,
    ".codex-plugin/plugin.json",
  );
  const sourceManifest = await readJson(sourceManifestPath);
  const fingerprint = await fingerprintPlugin(pluginRoot);
  const statePath = path.join(buildRoot, "state.json");
  const previous = await readJson(statePath, null);
  const generatedPluginRoot = path.join(
    buildRoot,
    "plugins/nuanu-flow-dev",
  );
  if (
    !options.force &&
    previous?.fingerprint === fingerprint &&
    previous?.mcpUrl === mode.mcpUrl &&
    (await outputExists(buildRoot))
  ) {
    return {
      changed: false,
      fingerprint,
      version: previous.version,
      marketplaceRoot: buildRoot,
      pluginRoot: generatedPluginRoot,
    };
  }

  const now = (options.now || (() => new Date()))();
  const baseVersion = String(sourceManifest.version || "0.1.0").split("+")[0];
  const version = `${baseVersion}+codex.local-${utcStamp(now)}.${fingerprint.slice(0, 12)}`;
  const parent = path.dirname(buildRoot);
  const tempRoot = path.join(
    parent,
    `.${path.basename(buildRoot)}.tmp-${process.pid}-${Date.now()}`,
  );
  const tempPluginRoot = path.join(tempRoot, "plugins/nuanu-flow-dev");

  await fs.mkdir(parent, { recursive: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
  try {
    await fs.cp(pluginRoot, tempPluginRoot, {
      recursive: true,
      preserveTimestamps: true,
    });
    const manifest = developmentManifest(sourceManifest, {
      version,
      mcpUrl: mode.mcpUrl,
    });
    await fs.writeFile(
      path.join(tempPluginRoot, ".codex-plugin/plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await fs.mkdir(path.join(tempRoot, ".agents/plugins"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tempRoot, ".agents/plugins/marketplace.json"),
      `${JSON.stringify(developmentMarketplace(), null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(tempRoot, "state.json"),
      `${JSON.stringify(
        {
          fingerprint,
          version,
          mcpUrl: mode.mcpUrl,
          generatedAt: now.toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    await replaceDirectory(tempRoot, buildRoot);
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    changed: true,
    fingerprint,
    version,
    marketplaceRoot: buildRoot,
    pluginRoot: generatedPluginRoot,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--build-only") options.buildOnly = true;
    else if (arg === "--mcp-url") {
      options.mcpUrl = argv[++index];
      if (!options.mcpUrl) throw new Error("--mcp-url requires a value");
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/codex/dev-package.mjs [options]

Options:
  --force          Rebuild even when the source fingerprint is unchanged.
  --mcp-url URL    Override NUANU_DEV_MCP_URL for this build.
  --build-only     Build without installing (accepted for npm script clarity).
  -h, --help       Show this help.
`);
    return;
  }
  const env = {
    ...process.env,
    ...(options.mcpUrl ? { NUANU_DEV_MCP_URL: options.mcpUrl } : {}),
  };
  const result = await buildDevPackage({ force: options.force, env });
  console.log(
    `${result.changed ? "built" : "unchanged"} ${result.version} at ${result.marketplaceRoot}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-dev-package] ${error.message}`);
    process.exit(1);
  });
}
