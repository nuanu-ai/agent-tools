#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  assertCodexVersion,
  codexHome as resolveCodexHome,
  runCodex,
} from "./modes.mjs";
import { classifyMarketplace } from "./setup.mjs";

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function installedVersion(body) {
  return (
    body.installed?.find(
      (plugin) => plugin.pluginId === "nuanu-flow@nuanu",
    )?.version || null
  );
}

export async function updateProduction(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const home = resolveCodexHome({ codexHome: options.codexHome });
  const env = {
    ...process.env,
    ...options.env,
    CODEX_HOME: home,
  };
  const codexOptions = {
    codexBin: options.codexBin,
    cwd: repoRoot,
    env,
  };
  const version = runCodex(["--version"], codexOptions);
  assertCodexVersion(version.stdout);
  const marketplaceBody = parseJson(
    "Codex marketplace list",
    runCodex(
      ["plugin", "marketplace", "list", "--json"],
      codexOptions,
    ).stdout,
  );
  const marketplace = marketplaceBody.marketplaces?.find(
    (entry) => entry.name === "nuanu",
  );
  if (!marketplace || classifyMarketplace(marketplace, repoRoot) !== "remote") {
    throw new Error(
      "Production marketplace nuanu is not Git-backed by nuanu-ai/agent-tools. Run npm run codex:setup.",
    );
  }

  const before = parseJson(
    "Codex plugin list",
    runCodex(["plugin", "list", "--available", "--json"], codexOptions)
      .stdout,
  );
  const oldVersion = installedVersion(before);
  runCodex(
    ["plugin", "marketplace", "upgrade", "nuanu", "--json"],
    codexOptions,
  );
  runCodex(
    ["plugin", "add", "nuanu-flow@nuanu", "--json"],
    codexOptions,
  );
  const after = parseJson(
    "Codex plugin list",
    runCodex(["plugin", "list", "--available", "--json"], codexOptions)
      .stdout,
  );
  const newVersion = installedVersion(after);
  return {
    oldVersion,
    newVersion,
    changed: oldVersion !== newVersion,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--codex-bin") {
      options.codexBin = argv[++index];
      if (!options.codexBin) throw new Error("--codex-bin requires a value");
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/codex/update.mjs [--codex-bin BIN]`);
    return;
  }
  const result = await updateProduction(options);
  console.log(
    result.changed
      ? `Nuanu Flow production plugin: ${result.oldVersion || "missing"} -> ${result.newVersion || "missing"}`
      : `Nuanu Flow production plugin unchanged at ${result.newVersion || "missing"}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-update] ${error.message}`);
    process.exit(1);
  });
}
