#!/usr/bin/env node

import { buildDevPackage } from "./dev-package.mjs";
import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  runCodex,
} from "./modes.mjs";

function usage() {
  console.log(`Usage: node scripts/codex/dev-install.mjs [options]

Deprecated compatibility command. Prefer:
  npm run codex:setup
  npm run codex:dev
  npm run codex:refresh

Options:
  --cachebuster[=TOKEN]   Force a new generated development version.
  --dry-run               Print actions without changing Codex configuration.
  --skip-marketplace      Do not refresh the development marketplace.
  --skip-install          Do not reinstall the development plugin.
  --codex-bin BIN         Codex binary to execute. Defaults to "codex".
  -h, --help              Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    codexBin: "codex",
    dryRun: false,
    force: false,
    skipMarketplace: false,
    skipInstall: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-marketplace") options.skipMarketplace = true;
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--cachebuster" || arg.startsWith("--cachebuster=")) {
      options.force = true;
    } else if (arg === "--codex-bin") {
      options.codexBin = argv[++index];
      if (!options.codexBin) throw new Error("--codex-bin requires a value");
    } else if (arg.startsWith("--codex-bin=")) {
      options.codexBin = arg.slice("--codex-bin=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printCommand(bin, args) {
  console.log(
    [bin, ...args]
      .map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))
      .join(" "),
  );
}

function execute(bin, args, options) {
  printCommand(bin, args);
  if (options.dryRun) return;
  runCodex(args, {
    codexBin: bin,
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

export async function devInstall(options = {}) {
  console.log(
    "Deprecated: this compatibility command now targets only nuanu-flow-dev@nuanu-dev.",
  );
  let result = {
    marketplaceRoot: DEFAULT_BUILD_ROOT,
    version: "generated-on-execution",
    changed: true,
  };
  if (!options.dryRun) {
    result = await buildDevPackage({
      force: options.force,
      env: options.env || process.env,
    });
    console.log(
      `${result.changed ? "built" : "unchanged"} development package ${result.version}`,
    );
  } else {
    console.log(
      `would ${options.force ? "force-build" : "build"} development package at ${DEFAULT_BUILD_ROOT}`,
    );
  }

  const commandOptions = {
    dryRun: options.dryRun,
  };
  if (!options.skipMarketplace) {
    execute(
      options.codexBin || "codex",
      ["plugin", "marketplace", "add", result.marketplaceRoot, "--json"],
      commandOptions,
    );
  }
  if (!options.skipInstall) {
    execute(
      options.codexBin || "codex",
      ["plugin", "add", "nuanu-flow-dev@nuanu-dev", "--json"],
      commandOptions,
    );
  }
  console.log("done: start a new Codex development session to load the plugin.");
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  await devInstall(options);
}

main().catch((error) => {
  console.error(`[codex-dev-install] ${error.message}`);
  process.exit(1);
});
