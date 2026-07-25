#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDevPackage } from "./dev-package.mjs";
import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  assertCodexVersion,
  codexModeHome,
  codexHome as resolveCodexHome,
  modeConfig,
  runCodex,
} from "./modes.mjs";

const MCP_BLOCK_PREFIX = "# >>> nuanu-flow managed MCP:";

function hasMcpServerDeclaration(text, serverName) {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const key = `(?:"${escaped}"|'${escaped}'|${escaped})`;
  const table = new RegExp(
    `^\\s*\\[\\s*(?:"mcp_servers"|'mcp_servers'|mcp_servers)\\s*\\.\\s*${key}(?:\\s*\\.|\\s*\\])`,
    "m",
  );
  const dottedKey = new RegExp(
    `^\\s*(?:"mcp_servers"|'mcp_servers'|mcp_servers)\\s*\\.\\s*${key}\\s*\\.`,
    "m",
  );
  return table.test(text) || dottedKey.test(text);
}

function modeMcpBlock(modeName, env) {
  const mode = modeConfig(modeName, env);
  const begin = `${MCP_BLOCK_PREFIX}${modeName} >>>`;
  const end = `# <<< nuanu-flow managed MCP:${modeName} <<<`;
  return `${begin}
[mcp_servers.${mode.mcpName}]
url = ${JSON.stringify(mode.mcpUrl)}
required = true
startup_timeout_sec = 20
tool_timeout_sec = 120
default_tools_approval_mode = "writes"

[mcp_servers.${mode.mcpName}.env_http_headers]
"X-Plane-User-Token" = ${JSON.stringify(mode.tokenEnv)}
"X-Agent-Key" = ${JSON.stringify(mode.agentKeyEnv)}
"X-Plane-Workspace" = ${JSON.stringify(mode.workspaceEnv)}
${end}`;
}

export async function writeModeMcpConfig(
  modeName,
  home,
  env = process.env,
) {
  const mode = modeConfig(modeName, env);
  const file = path.join(home, "config.toml");
  const begin = `${MCP_BLOCK_PREFIX}${modeName} >>>`;
  const end = `# <<< nuanu-flow managed MCP:${modeName} <<<`;
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const start = current.indexOf(begin);
  const finish = start < 0 ? -1 : current.indexOf(end, start);
  if (start >= 0 && finish < 0) {
    throw new Error(`Managed MCP block is incomplete in ${file}`);
  }
  let unmanaged =
    start < 0
      ? current
      : `${current.slice(0, start)}${current.slice(finish + end.length)}`;
  if (hasMcpServerDeclaration(unmanaged, mode.mcpName)) {
    throw new Error(
      `Refusing to replace unmanaged ${mode.mcpName} MCP config in ${file}`,
    );
  }
  unmanaged = unmanaged.trimEnd();
  const next = `${unmanaged ? `${unmanaged}\n\n` : ""}${modeMcpBlock(
    modeName,
    env,
  )}\n`;
  if (next === current) {
    await fs.chmod(file, 0o600);
    return "unchanged";
  }

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, next, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
  return start < 0 ? "created" : "updated";
}

export async function ensureSharedCodexAuth(baseHome, modeHome) {
  const source = path.join(baseHome, "auth.json");
  const destination = path.join(modeHome, "auth.json");
  try {
    await fs.access(source);
  } catch (error) {
    if (error.code === "ENOENT") return "source-missing";
    throw error;
  }

  await fs.mkdir(modeHome, { recursive: true, mode: 0o700 });
  await fs.chmod(modeHome, 0o700);
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace existing Codex auth file: ${destination}`,
      );
    }
    const existing = await fs.realpath(destination);
    if (existing !== (await fs.realpath(source))) {
      throw new Error(
        `Refusing to replace foreign Codex auth link: ${destination}`,
      );
    }
    return "unchanged";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.symlink(source, destination);
  return "created";
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
  if (sourceType === "git" && isNuanuRemote(source)) {
    return entry.marketplaceSource?.ref === "main"
      ? "remote"
      : "remote-other";
  }
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

function commandAction(mode, home, args, label, kind) {
  return { mode, home, kind, args, label };
}

function mcpConfigAction(mode, home) {
  return {
    mode,
    home,
    kind: "mcp-config-write",
    label: `write managed ${mode} MCP config`,
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

async function directoryExists(directory) {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function setup(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const buildRoot = options.buildRoot || DEFAULT_BUILD_ROOT;
  const baseHome = resolveCodexHome({
    codexHome: options.codexHome,
    env: options.env,
  });
  const homes = {
    prod: codexModeHome("prod", {
      codexHome: baseHome,
      env: options.env,
    }),
    dev: codexModeHome("dev", {
      codexHome: baseHome,
      env: options.env,
    }),
  };
  const baseEnv = {
    ...process.env,
    ...options.env,
  };
  const codexOptionsForHome = (home) => ({
    codexBin: options.codexBin || "codex",
    cwd: repoRoot,
    env: {
      ...baseEnv,
      CODEX_HOME: home,
    },
  });
  const codexOptions = (mode) => codexOptionsForHome(homes[mode]);
  if (!options.dryRun) {
    await Promise.all(
      Object.values(homes).map((home) =>
        fs.mkdir(home, { recursive: true, mode: 0o700 }),
      ),
    );
    await Promise.all(
      Object.values(homes).map((home) => fs.chmod(home, 0o700)),
    );
  }
  const versions = {
    prod: runCodex(["--version"], codexOptions("prod")),
    dev: runCodex(["--version"], codexOptions("dev")),
  };
  assertCodexVersion(versions.prod.stdout);
  assertCodexVersion(versions.dev.stdout);
  const build = await buildDevPackage({
    pluginRoot:
      options.pluginRoot || path.join(repoRoot, "plugins/nuanu-flow"),
    buildRoot,
    env: baseEnv,
    now: options.now,
    force: options.force,
  });
  let baseMarketplaces = [];
  let baseInstalled = [];
  if (await directoryExists(baseHome)) {
    baseMarketplaces = parseMarketplaceList(
      runCodex(
        ["plugin", "marketplace", "list", "--json"],
        codexOptionsForHome(baseHome),
      ).stdout,
    );
    const basePlugins = JSON.parse(
      runCodex(
        ["plugin", "list", "--available", "--json"],
        codexOptionsForHome(baseHome),
      ).stdout,
    );
    baseInstalled = basePlugins.installed || [];
  }
  const prodMarketplaces = (await directoryExists(homes.prod))
    ? parseMarketplaceList(
        runCodex(
          ["plugin", "marketplace", "list", "--json"],
          codexOptions("prod"),
        ).stdout,
      )
    : [];
  const production = prodMarketplaces.find((entry) => entry.name === "nuanu");
  const productionClass = production
    ? classifyMarketplace(production, repoRoot)
    : "absent";
  if (productionClass === "foreign") {
    throw new Error(
      "Refusing to replace a foreign marketplace named nuanu. Remove or rename it explicitly first.",
    );
  }

  const devMarketplaces = (await directoryExists(homes.dev))
    ? parseMarketplaceList(
        runCodex(
          ["plugin", "marketplace", "list", "--json"],
          codexOptions("dev"),
        ).stdout,
      )
    : [];
  const development = devMarketplaces.find(
    (entry) => entry.name === "nuanu-dev",
  );
  const developmentClass = classifyDevMarketplace(development, buildRoot);
  if (developmentClass === "foreign") {
    throw new Error(
      "Refusing to replace a foreign marketplace named nuanu-dev. Remove or rename it explicitly first.",
    );
  }

  const actions = [];
  const baseProduction = baseMarketplaces.find(
    (entry) => entry.name === "nuanu",
  );
  const baseDevelopment = baseMarketplaces.find(
    (entry) => entry.name === "nuanu-dev",
  );
  if (
    baseDevelopment &&
    classifyDevMarketplace(baseDevelopment, buildRoot) === "this-build"
  ) {
    if (
      baseInstalled.some(
        (plugin) => plugin.pluginId === "nuanu-flow-dev@nuanu-dev",
      )
    ) {
      actions.push(
        commandAction(
          "base",
          baseHome,
          ["plugin", "remove", "nuanu-flow-dev@nuanu-dev", "--json"],
          "remove legacy development plugin from base Codex home",
          "plugin-remove",
        ),
      );
    }
    actions.push(
      commandAction(
        "base",
        baseHome,
        ["plugin", "marketplace", "remove", "nuanu-dev", "--json"],
        "remove legacy development marketplace from base Codex home",
        "marketplace-remove",
      ),
    );
  }
  if (
    baseProduction &&
    classifyMarketplace(baseProduction, repoRoot) === "this-checkout"
  ) {
    if (
      baseInstalled.some(
        (plugin) => plugin.pluginId === "nuanu-flow@nuanu",
      )
    ) {
      actions.push(
        commandAction(
          "base",
          baseHome,
          ["plugin", "remove", "nuanu-flow@nuanu", "--json"],
          "remove legacy checkout plugin from base Codex home",
          "plugin-remove",
        ),
      );
    }
    actions.push(
      commandAction(
        "base",
        baseHome,
        ["plugin", "marketplace", "remove", "nuanu", "--json"],
        "remove legacy checkout marketplace from base Codex home",
        "marketplace-remove",
      ),
    );
  }
  if (
    productionClass === "this-checkout" ||
    productionClass === "remote-other"
  ) {
    actions.push(
      commandAction(
        "prod",
        homes.prod,
        ["plugin", "marketplace", "remove", "nuanu", "--json"],
        "remove noncanonical production marketplace",
        "marketplace-remove",
      ),
    );
  }
  if (productionClass !== "remote") {
    actions.push(
      commandAction(
        "prod",
        homes.prod,
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
  actions.push(
    commandAction(
      "prod",
      homes.prod,
      ["plugin", "add", "nuanu-flow@nuanu", "--json"],
      "install production plugin",
      "plugin-add",
    ),
    mcpConfigAction("prod", homes.prod),
  );
  if (developmentClass === "this-build") {
    actions.push(
      commandAction(
        "dev",
        homes.dev,
        ["plugin", "marketplace", "remove", "nuanu-dev", "--json"],
        "refresh local development marketplace",
        "marketplace-remove",
      ),
    );
  }
  actions.push(
    commandAction(
      "dev",
      homes.dev,
      ["plugin", "marketplace", "add", build.marketplaceRoot, "--json"],
      "register local development marketplace",
      "marketplace-add",
    ),
    commandAction(
      "dev",
      homes.dev,
      ["plugin", "add", "nuanu-flow-dev@nuanu-dev", "--json"],
      "install development plugin",
      "plugin-add",
    ),
    mcpConfigAction("dev", homes.dev),
  );

  if (!options.dryRun) {
    await Promise.all(
      Object.values(homes).map((home) =>
        ensureSharedCodexAuth(baseHome, home),
      ),
    );
    for (const action of actions) {
      if (action.args) {
        runCodex(action.args, codexOptionsForHome(action.home));
      } else {
        action.result = await writeModeMcpConfig(
          action.mode,
          action.home,
          baseEnv,
        );
      }
    }
  }

  return {
    dryRun: Boolean(options.dryRun),
    codexVersion: String(versions.prod.stdout).trim(),
    codexHome: baseHome,
    homes,
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
  console.log(`Base Codex home: ${report.codexHome}`);
  console.log(`Production home: ${report.homes.prod}`);
  console.log(`Development home: ${report.homes.dev}`);
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
