#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  probeEndpoint,
  probeOAuthMetadata,
  readMcpAuthStatus,
  resolveModeCredentials,
} from "./auth.mjs";
import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  assertCodexVersion,
  codexHome as resolveCodexHome,
  modeConfig,
  readJson,
  runCodex,
} from "./modes.mjs";
import { PROFILE_MARKER, profileText } from "./setup.mjs";

function parseJsonOutput(label, output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

async function profileStatus(modeName, home) {
  const file = path.join(home, `${modeConfig(modeName).profile}.config.toml`);
  try {
    const text = await fs.readFile(file, "utf8");
    return {
      path: file,
      exists: true,
      owned: text.startsWith(PROFILE_MARKER),
      correct: text === profileText(modeName),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      path: file,
      exists: false,
      owned: false,
      correct: false,
    };
  }
}

export async function collectStatus(options = {}) {
  const modeName = options.mode || "prod";
  const env = {
    ...process.env,
    ...options.env,
  };
  const mode = modeConfig(modeName, env);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const buildRoot = options.buildRoot || DEFAULT_BUILD_ROOT;
  const home = resolveCodexHome({ codexHome: options.codexHome });
  const childEnv = { ...env, CODEX_HOME: home };
  const codexOptions = {
    codexBin: options.codexBin,
    cwd: repoRoot,
    env: childEnv,
  };

  const versionResult = runCodex(["--version"], codexOptions);
  assertCodexVersion(versionResult.stdout);
  const marketplaceResult = runCodex(
    ["plugin", "marketplace", "list", "--json"],
    codexOptions,
  );
  const pluginResult = runCodex(
    ["plugin", "list", "--available", "--json"],
    codexOptions,
  );
  const marketplaces = parseJsonOutput(
    "Codex marketplace list",
    marketplaceResult.stdout,
  ).marketplaces;
  const plugins = parseJsonOutput("Codex plugin list", pluginResult.stdout);
  const installed = (plugins.installed || []).find(
    (plugin) => plugin.pluginId === mode.pluginId,
  );
  const state = await readJson(path.join(buildRoot, "state.json"), null);
  const canonical = await readJson(
    path.join(repoRoot, "plugins/nuanu-flow/.codex-plugin/plugin.json"),
  );
  const profile = await profileStatus(modeName, home);

  const [mcpEndpoint, apiEndpoint, oauth, mcpAuthStatus, credentials] =
    await Promise.all([
      probeEndpoint(mode.mcpUrl, options.endpointTimeoutMs),
      probeEndpoint(mode.apiUrl, options.endpointTimeoutMs),
      probeOAuthMetadata(mode.mcpUrl, {
        timeoutMs: options.endpointTimeoutMs,
      }),
      readMcpAuthStatus(modeName, codexOptions),
      resolveModeCredentials(modeName, env, options.keychain),
    ]);
  const authSource =
    mcpAuthStatus === "o_auth" ? "oauth" : credentials.report.source;

  return {
    mode: modeName,
    label: mode.label,
    pluginId: mode.pluginId,
    marketplace: mode.marketplace,
    mcpName: mode.mcpName,
    mcpUrl: mode.mcpUrl,
    apiUrl: mode.apiUrl,
    gatewayUrl: mode.gatewayUrl,
    codexVersion: String(versionResult.stdout).trim(),
    sourceVersion: canonical.version,
    generatedVersion: modeName === "dev" ? state?.version || null : null,
    installedVersion: installed?.version || null,
    marketplaceSource:
      marketplaces?.find((entry) => entry.name === mode.marketplace) || null,
    installed: Boolean(installed),
    profile,
    endpoints: {
      mcp: mcpEndpoint,
      api: apiEndpoint,
    },
    oauth: {
      status: oauth.status,
      probe: oauth.probe,
      mcpAuthStatus,
    },
    auth: credentials.report.source === authSource
      ? credentials.report
      : {
          mode: modeName,
          source: authSource,
          tokenPresent: false,
          agentKeyPresent: false,
          workspacePresent: credentials.report.workspacePresent,
          persistent: true,
        },
  };
}

export async function preflight(modeName, options = {}) {
  const report = await collectStatus({ ...options, mode: modeName });
  if (!report.profile.correct) {
    throw new Error(
      `${report.label} profile is missing or unmanaged: ${report.profile.path}. Run npm run codex:setup.`,
    );
  }
  if (!report.installed) {
    throw new Error(
      `${report.pluginId} is not installed. Run npm run codex:setup.`,
    );
  }
  if (modeName === "dev" && report.endpoints.mcp.status !== "reachable") {
    throw new Error(
      `Development MCP endpoint is ${report.endpoints.mcp.status}: ${report.mcpUrl}`,
    );
  }
  if (
    modeName === "dev" &&
    options.worker &&
    report.endpoints.api.status !== "reachable"
  ) {
    throw new Error(
      `Development API endpoint is ${report.endpoints.api.status}: ${report.apiUrl}`,
    );
  }
  return report;
}

export function formatStatus(report) {
  return [
    `Mode: ${report.label} (${report.mode})`,
    `Plugin: ${report.pluginId}`,
    `Versions: source=${report.sourceVersion} installed=${report.installedVersion || "missing"}${report.generatedVersion ? ` generated=${report.generatedVersion}` : ""}`,
    `Profile: ${report.profile.path} (${report.profile.correct ? "ready" : "not ready"})`,
    `MCP: ${report.mcpUrl} (${report.endpoints.mcp.status})`,
    `API: ${report.apiUrl} (${report.endpoints.api.status})`,
    `Auth: ${report.auth.source}`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = { json: false, modes: ["prod", "dev"] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--mode") {
      const mode = argv[++index];
      if (mode !== "prod" && mode !== "dev") {
        throw new Error("--mode requires prod or dev");
      }
      options.modes = [mode];
    } else if (arg === "--codex-bin") {
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
    console.log(`Usage: node scripts/codex/status.mjs [options]

Options:
  --mode prod|dev  Report one mode. Defaults to both.
  --json           Print JSON.
  --codex-bin BIN  Codex binary to execute. Defaults to "codex".
  -h, --help       Show this help.
`);
    return;
  }
  const reports = [];
  for (const mode of options.modes) {
    reports.push(await collectStatus({ mode, codexBin: options.codexBin }));
  }
  if (options.json) {
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  } else {
    console.log(reports.map(formatStatus).join("\n\n"));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-status] ${error.message}`);
    process.exit(1);
  });
}
