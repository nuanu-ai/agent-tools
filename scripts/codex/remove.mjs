#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_KEYCHAIN_SERVICE,
  keychainAccount,
  systemKeychain,
} from "./auth.mjs";
import { readHookTrustStatus } from "./hook-status.mjs";
import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  codexHome as resolveCodexHome,
  codexModeHome,
  runCodex,
} from "./modes.mjs";

const NUANU_PLUGIN_IDS = new Set([
  "nuanu-flow@nuanu",
  "nuanu-flow-dev@nuanu-dev",
]);
const NUANU_MARKETPLACES = new Set(["nuanu", "nuanu-dev"]);

async function directoryExists(directory) {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function assertSafeRemovalTargets(baseHome, isolatedRoot, buildRoot) {
  if (path.parse(baseHome).root === path.resolve(baseHome)) {
    throw new Error(`Refusing to use filesystem root as Codex home: ${baseHome}`);
  }
  if (
    path.dirname(isolatedRoot) !== path.resolve(baseHome) ||
    path.basename(isolatedRoot) !== "nuanu-flow"
  ) {
    throw new Error(
      `Refusing unexpected isolated Nuanu Flow path: ${isolatedRoot}`,
    );
  }
  if (path.basename(buildRoot) !== "codex-dev") {
    throw new Error(
      `Refusing unexpected generated development path: ${buildRoot}`,
    );
  }
}

function commandAction(home, args, label) {
  return { kind: "command", home, args, label };
}

function removePathAction(target, label) {
  return { kind: "remove-path", target, label };
}

function keychainAction(mode) {
  return {
    kind: "keychain-remove",
    mode,
    label: `remove saved ${mode} fallback token`,
  };
}

function hookTrustAction(home, keys, label) {
  return {
    kind: "remove-hook-trust",
    home,
    keys,
    label,
  };
}

async function removeHookTrustEntries(home, keys) {
  if (!keys.length) return false;
  const configPath = path.join(home, "config.toml");
  let body;
  try {
    body = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const headers = new Set(
    keys.flatMap((key) => [
      `[hooks.state.${JSON.stringify(key)}]`,
      ...(key.includes("'") ? [] : [`[hooks.state.'${key}']`]),
    ]),
  );
  const output = [];
  let removing = false;
  for (const line of body.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      removing = headers.has(trimmed);
    }
    if (!removing) output.push(line);
  }
  const next = output.join("");
  if (next === body) return false;
  const tempPath = path.join(
    home,
    `.config.toml.nuanu-cleanup-${process.pid}-${Date.now()}`,
  );
  await fs.writeFile(tempPath, next, { mode: 0o600 });
  await fs.rename(tempPath, configPath);
  return true;
}

async function homeRemovalActions(
  home,
  label,
  codexOptions,
  hookStatusReader,
) {
  if (!(await directoryExists(home))) return [];

  const plugins = parseJson(
    runCodex(["plugin", "list", "--available", "--json"], codexOptions(home))
      .stdout,
    `Codex plugin list for ${label}`,
  );
  const marketplaces = parseJson(
    runCodex(["plugin", "marketplace", "list", "--json"], codexOptions(home))
      .stdout,
    `Codex marketplace list for ${label}`,
  );
  const actions = [];
  const hasNuanuPlugin = (plugins.installed || []).some((plugin) =>
    NUANU_PLUGIN_IDS.has(plugin.pluginId),
  );

  if (hasNuanuPlugin) {
    const hookKeys = [];
    for (const plugin of plugins.installed || []) {
      if (!NUANU_PLUGIN_IDS.has(plugin.pluginId)) continue;
      const hook = await hookStatusReader({
        ...codexOptions(home),
        pluginId: plugin.pluginId,
      });
      hookKeys.push(
        ...(hook.hooks || [])
          .map((entry) => entry.key)
          .filter((key) => typeof key === "string" && key),
      );
    }
    if (hookKeys.length) {
      actions.push(
        hookTrustAction(
          home,
          [...new Set(hookKeys)],
          `remove Nuanu Flow hook trust from ${label}`,
        ),
      );
    }
    const mcpServers = parseJson(
      runCodex(["mcp", "list", "--json"], codexOptions(home)).stdout,
      `Codex MCP list for ${label}`,
    );
    const nuanuMcp = Array.isArray(mcpServers)
      ? mcpServers.find((server) => server.name === "nuanu-flow")
      : null;
    if (nuanuMcp?.auth_status === "o_auth") {
      actions.push(
        commandAction(
          home,
          ["mcp", "logout", "nuanu-flow"],
          `log out nuanu-flow OAuth from ${label}`,
        ),
      );
    }
  }

  for (const plugin of plugins.installed || []) {
    if (!NUANU_PLUGIN_IDS.has(plugin.pluginId)) continue;
    actions.push(
      commandAction(
        home,
        ["plugin", "remove", plugin.pluginId, "--json"],
        `remove ${plugin.pluginId} from ${label}`,
      ),
    );
  }
  for (const marketplace of marketplaces.marketplaces || []) {
    if (!NUANU_MARKETPLACES.has(marketplace.name)) continue;
    actions.push(
      commandAction(
        home,
        [
          "plugin",
          "marketplace",
          "remove",
          marketplace.name,
          "--json",
        ],
        `remove ${marketplace.name} marketplace from ${label}`,
      ),
    );
  }
  return actions;
}

export async function removeNuanuFlow(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const buildRoot = path.resolve(options.buildRoot || DEFAULT_BUILD_ROOT);
  const baseHome = path.resolve(
    resolveCodexHome({
      codexHome: options.codexHome,
      env: options.env,
    }),
  );
  const homes = {
    base: baseHome,
    prod: codexModeHome("prod", {
      codexHome: baseHome,
      env: options.env,
    }),
    dev: codexModeHome("dev", {
      codexHome: baseHome,
      env: options.env,
    }),
  };
  const isolatedRoot = path.dirname(homes.prod);
  assertSafeRemovalTargets(baseHome, isolatedRoot, buildRoot);

  const baseEnv = { ...process.env, ...options.env };
  const keychain = options.keychain || systemKeychain;
  const hookStatusReader =
    options.readHookTrustStatus || readHookTrustStatus;
  const codexOptions = (home) => ({
    codexBin: options.codexBin || "codex",
    cwd: repoRoot,
    env: {
      ...baseEnv,
      CODEX_HOME: home,
    },
  });

  const actions = [];
  for (const [name, home] of Object.entries(homes)) {
    actions.push(
      ...(await homeRemovalActions(
        home,
        `${name} Codex home`,
        codexOptions,
        hookStatusReader,
      )),
    );
  }
  for (const marketplace of NUANU_MARKETPLACES) {
    actions.push(
      removePathAction(
        path.join(baseHome, "plugins", "cache", marketplace),
        `remove ${marketplace} plugin cache`,
      ),
    );
  }
  actions.push(
    keychainAction("prod"),
    keychainAction("dev"),
    removePathAction(
      isolatedRoot,
      "remove isolated Nuanu Flow MCP and OAuth profiles",
    ),
    removePathAction(buildRoot, "remove generated development plugin"),
  );

  if (!options.dryRun) {
    for (const action of actions) {
      if (action.kind === "command") {
        runCodex(action.args, codexOptions(action.home));
      } else if (action.kind === "remove-hook-trust") {
        await removeHookTrustEntries(action.home, action.keys);
      } else if (action.kind === "keychain-remove") {
        await keychain.remove?.({
          service: CODEX_KEYCHAIN_SERVICE,
          account: keychainAccount(action.mode),
        });
      } else {
        await fs.rm(action.target, { recursive: true, force: true });
      }
    }
  }

  return {
    dryRun: Boolean(options.dryRun),
    baseHome,
    homes,
    buildRoot,
    actions,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--codex-bin") {
      options.codexBin = argv[++index];
      if (!options.codexBin) throw new Error("--codex-bin requires a value");
    } else if (arg.startsWith("--codex-bin=")) {
      options.codexBin = arg.slice("--codex-bin=".length);
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printReport(report) {
  console.log(`Base Codex home: ${report.baseHome}`);
  for (const action of report.actions) {
    console.log(`${report.dryRun ? "would " : ""}${action.label}`);
  }
  if (!report.dryRun) {
    console.log("Nuanu Flow was completely removed from Codex.");
    console.log(
      "Run npm run codex:install:dev for a fresh terminal and browser-OAuth install.",
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/codex/remove.mjs [options]

Log out Nuanu MCP OAuth, then remove Nuanu Flow plugins, hook trust,
marketplaces, isolated profiles, saved Codex-mode fallback tokens, caches, and
the generated development package. Preserve the base Codex login,
remote-worker credential, unrelated hooks, and unrelated plugins.

Options:
  --dry-run          Print the removal plan without changing Codex state.
  --codex-bin PATH   Use a specific Codex executable.
  -h, --help         Show this help.
`);
    return;
  }
  printReport(await removeNuanuFlow(options));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(`[codex-remove] ${error.stack || error.message}`);
    process.exit(1);
  });
}
