#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDevPackage } from "./dev-package.mjs";
import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  assertCodexVersion,
  codexHome as resolveCodexHome,
  runCodex,
} from "./modes.mjs";

export const PROFILE_MARKER =
  "# Managed by nuanu-agent-tools codex setup. Do not edit.";

export function profileText(mode) {
  if (mode !== "prod" && mode !== "dev") {
    throw new Error(`Unknown Nuanu Flow profile mode "${mode}"`);
  }
  const prodEnabled = mode === "prod";
  return `${PROFILE_MARKER}
[plugins."nuanu-flow@nuanu"]
enabled = ${prodEnabled}

[plugins."nuanu-flow-dev@nuanu-dev"]
enabled = ${!prodEnabled}
`;
}

export async function writeOwnedProfile(file, text) {
  let current = null;
  try {
    current = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current != null && !current.startsWith(PROFILE_MARKER)) {
    throw new Error(`Refusing to overwrite unowned Codex profile: ${file}`);
  }
  if (current === text) {
    await fs.chmod(file, 0o600);
    return "unchanged";
  }

  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
  return current == null ? "created" : "updated";
}

function normalized(value) {
  return value ? path.resolve(value) : "";
}

function isNuanuRemote(source) {
  return (
    source === "nuanu-ai/agent-tools" ||
    /^https:\/\/github\.com\/nuanu-ai\/agent-tools(?:\.git)?$/.test(source) ||
    /^git@github\.com:nuanu-ai\/agent-tools(?:\.git)?$/.test(source)
  );
}

export function classifyMarketplace(entry, repoRoot = REPO_ROOT) {
  const source = entry?.marketplaceSource?.source || "";
  const sourceType = entry?.marketplaceSource?.sourceType || "";
  if (
    sourceType === "local" &&
    (normalized(source) === normalized(repoRoot) ||
      normalized(entry?.root) === normalized(repoRoot))
  ) {
    return "this-checkout";
  }
  if (sourceType === "git" && isNuanuRemote(source)) return "remote";
  return "foreign";
}

function classifyDevMarketplace(entry, buildRoot) {
  if (!entry) return "absent";
  const source = entry.marketplaceSource?.source || entry.root || "";
  if (
    entry.marketplaceSource?.sourceType === "local" &&
    normalized(source) === normalized(buildRoot)
  ) {
    return "this-build";
  }
  return "foreign";
}

function commandAction(args, label, kind) {
  return { kind, args, label };
}

function profileAction(file, mode) {
  return {
    kind: "profile-write",
    file,
    mode,
    label: `write ${mode} profile ${file}`,
  };
}

function parseMarketplaceList(stdout) {
  let body;
  try {
    body = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Codex marketplace list returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(body.marketplaces)) {
    throw new Error("Codex marketplace list JSON is missing marketplaces");
  }
  return body.marketplaces;
}

export async function setup(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const buildRoot = options.buildRoot || DEFAULT_BUILD_ROOT;
  const home = resolveCodexHome({ codexHome: options.codexHome });
  const childEnv = {
    ...process.env,
    ...options.env,
    CODEX_HOME: home,
  };
  const codexOptions = {
    codexBin: options.codexBin || "codex",
    cwd: repoRoot,
    env: childEnv,
  };

  const version = runCodex(["--version"], codexOptions);
  assertCodexVersion(version.stdout);
  const build = await buildDevPackage({
    pluginRoot:
      options.pluginRoot || path.join(repoRoot, "plugins/nuanu-flow"),
    buildRoot,
    env: childEnv,
    now: options.now,
    force: options.force,
  });
  const listed = runCodex(
    ["plugin", "marketplace", "list", "--json"],
    codexOptions,
  );
  const marketplaces = parseMarketplaceList(listed.stdout);
  const production = marketplaces.find((entry) => entry.name === "nuanu");
  const development = marketplaces.find((entry) => entry.name === "nuanu-dev");
  const productionClass = production
    ? classifyMarketplace(production, repoRoot)
    : "absent";
  const developmentClass = classifyDevMarketplace(development, buildRoot);

  if (productionClass === "foreign") {
    throw new Error(
      "Refusing to replace a foreign marketplace named nuanu. Remove or rename it explicitly first.",
    );
  }
  if (developmentClass === "foreign") {
    throw new Error(
      "Refusing to replace a foreign marketplace named nuanu-dev. Remove or rename it explicitly first.",
    );
  }

  const actions = [];
  if (productionClass === "this-checkout") {
    actions.push(
      commandAction(
        ["plugin", "marketplace", "remove", "nuanu", "--json"],
        "remove old checkout-backed production marketplace",
        "marketplace-remove",
      ),
    );
  }
  if (productionClass !== "remote") {
    actions.push(
      commandAction(
        [
          "plugin",
          "marketplace",
          "add",
          "nuanu-ai/agent-tools",
          "--ref",
          "main",
          "--json",
        ],
        "register Git-backed production marketplace",
        "marketplace-add",
      ),
    );
  }
  if (developmentClass === "this-build") {
    actions.push(
      commandAction(
        ["plugin", "marketplace", "remove", "nuanu-dev", "--json"],
        "refresh local development marketplace",
        "marketplace-remove",
      ),
    );
  }
  actions.push(
    commandAction(
      ["plugin", "marketplace", "add", build.marketplaceRoot, "--json"],
      "register local development marketplace",
      "marketplace-add",
    ),
    commandAction(
      ["plugin", "add", "nuanu-flow@nuanu", "--json"],
      "install production plugin",
      "plugin-add",
    ),
    commandAction(
      ["plugin", "add", "nuanu-flow-dev@nuanu-dev", "--json"],
      "install development plugin",
      "plugin-add",
    ),
  );

  const prodProfile = path.join(home, "nuanu-flow-prod.config.toml");
  const devProfile = path.join(home, "nuanu-flow-dev.config.toml");
  actions.push(profileAction(prodProfile, "prod"), profileAction(devProfile, "dev"));

  if (!options.dryRun) {
    for (const action of actions) {
      if (action.args) {
        runCodex(action.args, codexOptions);
      } else {
        action.result = await writeOwnedProfile(
          action.file,
          profileText(action.mode),
        );
      }
    }
  }

  return {
    dryRun: Boolean(options.dryRun),
    codexVersion: String(version.stdout).trim(),
    codexHome: home,
    build,
    actions,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
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
  console.log(`Codex: ${report.codexVersion}`);
  console.log(`Codex home: ${report.codexHome}`);
  console.log(
    `Development package: ${report.build.version} (${report.build.changed ? "rebuilt" : "unchanged"})`,
  );
  for (const action of report.actions) {
    console.log(`${report.dryRun ? "would " : ""}${action.label}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/codex/setup.mjs [options]

Options:
  --dry-run          Print the setup plan without changing Codex configuration.
  --force            Force regeneration of the development package.
  --codex-bin BIN    Codex binary to execute. Defaults to "codex".
  -h, --help         Show this help.
`);
    return;
  }
  printReport(await setup(options));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-setup] ${error.message}`);
    process.exit(1);
  });
}
