#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveModeCredentials } from "./auth.mjs";
import { buildDevPackage } from "./dev-package.mjs";
import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  codexModeHome,
  codexHome as resolveCodexHome,
  modeConfig,
  runCodex,
} from "./modes.mjs";
import {
  ensureSharedCodexAuth,
  writeModeMcpConfig,
} from "./setup.mjs";
import { preflight } from "./status.mjs";

export function parseRunModeArgs(argv) {
  const mode = argv[0];
  if (mode !== "prod" && mode !== "dev") {
    throw new Error("Usage: node scripts/codex/run-mode.mjs <prod|dev> [options]");
  }
  const options = {
    mode,
    forceRefresh: false,
    noLaunch: false,
    dryRun: false,
    cwd: process.cwd(),
    codexArgs: [],
    codexBin: "codex",
  };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      options.codexArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "--force-refresh") options.forceRefresh = true;
    else if (arg === "--no-launch") options.noLaunch = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--cwd") {
      const value = argv[++index];
      if (!value) throw new Error("--cwd requires a value");
      options.cwd = path.resolve(value);
    } else if (arg === "--codex-bin") {
      options.codexBin = argv[++index];
      if (!options.codexBin) throw new Error("--codex-bin requires a value");
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function modeBanner(mode, installedVersion = "", home = "") {
  const rule = "=".repeat(72);
  return [
    rule,
    `NUANU FLOW ${mode.label}`,
    `Plugin: ${mode.pluginId}${installedVersion ? ` (${installedVersion})` : ""}`,
    `MCP: ${mode.mcpUrl}`,
    `Codex home: ${home}`,
    rule,
  ].join("\n");
}

export async function buildCodexLaunch(modeName, options = {}) {
  const env = options.env || process.env;
  const mode = modeConfig(modeName, env);
  const credentials = await resolveModeCredentials(
    modeName,
    env,
    options.keychain,
  );
  const home = codexModeHome(modeName, {
    codexHome: options.codexHome,
    env,
  });
  const baseHome = resolveCodexHome({
    codexHome: options.codexHome,
    env,
  });
  credentials.env.CODEX_HOME = home;
  credentials.env.NUANU_CODEX_BASE_HOME = baseHome;
  return {
    args: [...(options.codexArgs || [])],
    env: credentials.env,
    cwd: options.cwd || process.cwd(),
    banner: modeBanner(mode, options.installedVersion, home),
    auth: credentials.report,
  };
}

function classifyDevelopmentMarketplace(entry, buildRoot) {
  if (!entry) return "absent";
  const source = entry.marketplaceSource?.source || entry.root || "";
  if (
    entry.marketplaceSource?.sourceType === "local" &&
    path.resolve(source) === path.resolve(buildRoot)
  ) {
    return "this-build";
  }
  return "foreign";
}

async function syncDevelopment(options) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const buildRoot = options.buildRoot || DEFAULT_BUILD_ROOT;
  const env = {
    ...process.env,
    ...options.env,
    CODEX_HOME: codexModeHome("dev", {
      codexHome: options.codexHome,
      env: options.env,
    }),
  };
  const build = await buildDevPackage({
    pluginRoot: path.join(repoRoot, "plugins/nuanu-flow"),
    buildRoot,
    env,
    force: options.forceRefresh,
  });
  const commandOptions = {
    codexBin: options.codexBin,
    cwd: repoRoot,
    env,
  };
  const listed = runCodex(
    ["plugin", "marketplace", "list", "--json"],
    commandOptions,
  );
  const marketplaces = JSON.parse(listed.stdout).marketplaces || [];
  const current = marketplaces.find((entry) => entry.name === "nuanu-dev");
  const classification = classifyDevelopmentMarketplace(current, buildRoot);
  if (classification === "foreign") {
    throw new Error(
      "The nuanu-dev marketplace points somewhere else. Run npm run codex:setup.",
    );
  }
  let registered = false;
  if (classification === "absent") {
    runCodex(
      ["plugin", "marketplace", "add", buildRoot, "--json"],
      commandOptions,
    );
    registered = true;
  }
  if (build.changed || registered || options.forceRefresh) {
    runCodex(
      ["plugin", "add", "nuanu-flow-dev@nuanu-dev", "--json"],
      commandOptions,
    );
  }
  await writeModeMcpConfig("dev", env.CODEX_HOME, env);
  return build;
}

export async function runMode(options) {
  const mode = modeConfig(options.mode, options.env || process.env);
  if (options.dryRun) {
    const launch = await buildCodexLaunch(options.mode, options);
    console.log(launch.banner);
    console.log(
      options.mode === "dev"
        ? `would sync ${options.buildRoot || DEFAULT_BUILD_ROOT}`
        : "production launch never updates plugins automatically",
    );
    console.log(
      options.noLaunch
        ? "would not launch Codex"
        : `would launch ${options.codexBin} ${launch.args.join(" ")}`,
    );
    return 0;
  }

  let build = null;
  if (options.mode === "dev") build = await syncDevelopment(options);
  const baseHome = resolveCodexHome({
    codexHome: options.codexHome,
    env: options.env,
  });
  await ensureSharedCodexAuth(
    baseHome,
    codexModeHome(options.mode, {
      codexHome: baseHome,
      env: options.env,
    }),
  );
  const launch = await buildCodexLaunch(options.mode, {
    ...options,
    installedVersion: build?.version,
  });
  const status = await preflight(options.mode, {
    repoRoot: options.repoRoot,
    buildRoot: options.buildRoot,
    codexHome: baseHome,
    codexBin: options.codexBin,
    env: launch.env,
  });
  launch.banner = modeBanner(
    mode,
    status.installedVersion || build?.version,
    status.codexHome,
  );
  console.log(launch.banner);
  if (options.noLaunch) return 0;

  const result = runCodex(launch.args, {
    codexBin: options.codexBin,
    cwd: launch.cwd,
    env: launch.env,
    stdio: "inherit",
    allowFailure: true,
  });
  return result.status ?? 1;
}

async function main() {
  const options = parseRunModeArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/codex/run-mode.mjs <prod|dev> [options] [-- CODEX_ARGS...]

Options:
  --cwd DIR          Set the Codex working directory.
  --force-refresh    Force a new development build version.
  --no-launch        Sync and verify without starting Codex.
  --dry-run          Print actions without changing config or launching.
  --codex-bin BIN    Codex binary to execute. Defaults to "codex".
`);
    return;
  }
  process.exitCode = await runMode(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-${process.argv[2] || "mode"}] ${error.message}`);
    process.exit(1);
  });
}
