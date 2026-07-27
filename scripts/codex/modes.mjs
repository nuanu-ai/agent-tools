import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DEFAULT_BUILD_ROOT = path.join(REPO_ROOT, ".build/codex-dev");
export const MIN_CODEX_VERSION = "0.145.0";

export const MODES = Object.freeze({
  prod: Object.freeze({
    name: "prod",
    label: "PRODUCTION",
    marketplace: "nuanu",
    pluginName: "nuanu-flow",
    pluginId: "nuanu-flow@nuanu",
    mcpName: "nuanu-flow",
    mcpUrl: "https://flow.nuanu.com/mcp-server/mcp",
    apiUrl: "https://flow.nuanu.com/api",
    gatewayUrl: "wss://flow.nuanu.com/live/agent-gateway",
    tokenEnv: "NUANU_TOKEN",
    agentKeyEnv: "NUANU_AGENT_KEY",
    workspaceEnv: "NUANU_WORKSPACE",
  }),
  dev: Object.freeze({
    name: "dev",
    label: "LOCAL DEVELOPMENT",
    marketplace: "nuanu-dev",
    pluginName: "nuanu-flow-dev",
    pluginId: "nuanu-flow-dev@nuanu-dev",
    mcpName: "nuanu-flow",
    mcpUrl: "http://localhost:3001/mcp",
    apiUrl: "http://localhost:8000/api",
    gatewayUrl: "ws://localhost:3100/live/agent-gateway",
    tokenEnv: "NUANU_DEV_TOKEN",
    agentKeyEnv: "NUANU_DEV_AGENT_KEY",
    workspaceEnv: "NUANU_DEV_WORKSPACE",
  }),
});

export function modeConfig(name, env = process.env) {
  const mode = MODES[name];
  if (!mode) {
    throw new Error(`Unknown Nuanu Flow mode "${name}". Expected prod or dev.`);
  }
  if (name === "prod") return { ...mode };
  return {
    ...mode,
    mcpUrl: env.NUANU_DEV_MCP_URL || mode.mcpUrl,
    apiUrl: env.NUANU_DEV_URL || mode.apiUrl,
    gatewayUrl: env.NUANU_DEV_GATEWAY_URL || mode.gatewayUrl,
  };
}

function parseVersion(value) {
  const match = String(value).match(/(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function assertCodexVersion(
  versionText,
  minimum = MIN_CODEX_VERSION,
) {
  const actual = parseVersion(versionText);
  const required = parseVersion(minimum);
  if (!actual) {
    throw new Error(`Could not parse Codex version from: ${versionText}`);
  }
  if (!required || compareVersions(actual, required) < 0) {
    throw new Error(
      `Codex ${minimum} or newer is required; found ${actual.join(".")}.`,
    );
  }
}

export function codexHome(options = {}) {
  const env = options.env || process.env;
  const selected =
    options.codexHome ||
    env.NUANU_CODEX_BASE_HOME ||
    env.CODEX_HOME ||
    path.join(os.homedir(), ".codex");
  const modeName = path.basename(selected);
  const modeParent = path.dirname(selected);
  if (
    (modeName === "prod" || modeName === "dev") &&
    path.basename(modeParent) === "nuanu-flow"
  ) {
    return path.dirname(modeParent);
  }
  return selected;
}

export function codexModeHome(name, options = {}) {
  modeConfig(name, options.env || process.env);
  return path.join(codexHome(options), "nuanu-flow", name);
}

export function runCodex(args, options = {}) {
  const result = spawnSync(options.codexBin || "codex", args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    input: options.input,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `codex ${args.join(" ")} exited ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && arguments.length > 1) return fallback;
    throw new Error(`Could not read JSON from ${file}: ${error.message}`);
  }
}
