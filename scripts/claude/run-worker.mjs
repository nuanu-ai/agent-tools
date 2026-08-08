#!/usr/bin/env node

/**
 * Launch the Nuanu Flow remote-agent worker on a Claude Code host.
 *
 * The worker and the communication bus ship in two separately installed
 * plugins, so their roots are resolved from the host plugin registry
 * (`claude plugin list --json` → `installPath`). The launcher never guesses a
 * sibling cache directory and never mixes a development plugin with a
 * production one.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const MODES = {
  prod: {
    name: "prod",
    label: "PRODUCTION",
    pluginId: "nuanu-flow@nuanu",
    workerPluginId: "nuanu-flow-worker@nuanu",
    agentKeyEnv: "NUANU_AGENT_KEY",
    apiUrl: "https://flow.nuanu.com/api",
    gatewayUrl: "wss://flow.nuanu.com/live/agent-gateway",
  },
  dev: {
    name: "dev",
    label: "DEVELOPMENT",
    pluginId: "nuanu-flow-dev@nuanu-dev",
    workerPluginId: "nuanu-flow-worker-dev@nuanu-dev",
    agentKeyEnv: "NUANU_DEV_AGENT_KEY",
    apiUrl: "http://localhost:8000/api",
    gatewayUrl: "ws://localhost:3100/live/agent-gateway",
  },
};

const AGENT_BUS_RELATIVE = "scripts/agent-bus/agent-bus.mjs";
const WORKER_RELATIVE = "scripts/worker/worker.mjs";

function assertLocalUrl(rawUrl, label) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Development worker ${label} is invalid: ${rawUrl}`);
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error(
      `Development worker ${label} must use localhost or loopback: ${rawUrl}`,
    );
  }
}

function assertProductionUrl(rawUrl, label, protocol) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Production worker ${label} is invalid: ${rawUrl}`);
  }
  if (
    url.protocol !== protocol ||
    url.hostname !== "flow.nuanu.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Production worker ${label} must use ${protocol}//flow.nuanu.com: ${rawUrl}`,
    );
  }
}

function defaultCommand(args, options = {}) {
  const result = spawnSync(options.claudeBin || "claude", args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `claude ${args.join(" ")} failed (${result.status}): ${String(
        result.stderr || "",
      ).trim()}`,
    );
  }
  return String(result.stdout || "");
}

/**
 * Resolve the installed general and worker plugin roots for one mode. Both
 * must be installed, enabled, and expose a usable `installPath`; a partial or
 * cross-mode pair is a hard error rather than a silently degraded worker.
 */
export function resolvePluginRoots(modeName, options = {}) {
  const mode = MODES[modeName];
  if (!mode) throw new Error("Mode must be dev or prod");
  const runner = options.command || defaultCommand;
  const listed = JSON.parse(
    runner(["plugin", "list", "--json"], {
      claudeBin: options.claudeBin,
      cwd: options.cwd,
      env: options.env,
    }) || "null",
  );
  const plugins = Array.isArray(listed) ? listed : [];

  const pick = (pluginId, role) => {
    const entry = plugins.find((candidate) => candidate?.id === pluginId);
    if (!entry) {
      throw new Error(
        `${pluginId} is not installed. Run \`npm run claude:install:worker:${modeName}\` first.`,
      );
    }
    if (!entry.enabled) {
      throw new Error(
        `${pluginId} is installed but disabled. Enable it with \`claude plugin enable ${pluginId}\`.`,
      );
    }
    if (!entry.installPath) {
      throw new Error(
        `${pluginId} reported no installPath; this Claude Code build cannot supply the ${role} plugin root.`,
      );
    }
    return path.resolve(entry.installPath);
  };

  const opposite = modeName === "dev" ? MODES.prod : MODES.dev;
  for (const strayId of [opposite.pluginId, opposite.workerPluginId]) {
    if (plugins.some((entry) => entry?.id === strayId && entry.enabled)) {
      throw new Error(
        `Refusing to start a ${mode.label.toLowerCase()} worker while ${strayId} is also enabled. Install exactly one environment pair.`,
      );
    }
  }

  const generalRoot = pick(mode.pluginId, "communication bus");
  const workerRoot = pick(mode.workerPluginId, "worker");
  const agentBusScript = path.join(generalRoot, AGENT_BUS_RELATIVE);
  const workerScript = path.join(workerRoot, WORKER_RELATIVE);
  for (const [label, file] of [
    ["agent bus script", agentBusScript],
    ["worker script", workerScript],
  ]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Installed ${label} is missing: ${file}`);
    }
  }
  return { generalRoot, workerRoot, agentBusScript, workerScript };
}

function workerBanner(mode, env, roots) {
  return [
    "=".repeat(72),
    `NUANU FLOW ${mode.label} WORKER (Claude Code)`,
    `API: ${env.NUANU_URL}`,
    `Gateway: ${env.NUANU_GATEWAY_URL}`,
    `Adapter: ${env.NUANU_ADAPTER}`,
    `Agent bus: ${roots.agentBusScript}`,
    `Worker: ${roots.workerScript}`,
    "=".repeat(72),
  ].join("\n");
}

export function buildWorkerLaunch(modeName, options = {}) {
  const mode = MODES[modeName];
  if (!mode) throw new Error("Mode must be dev or prod");
  const sourceEnv = options.env || process.env;
  const roots = options.roots || resolvePluginRoots(modeName, options);

  const env = { ...sourceEnv };
  const opposite = modeName === "dev" ? MODES.prod : MODES.dev;
  delete env[opposite.agentKeyEnv];

  const apiUrl = sourceEnv.NUANU_URL || mode.apiUrl;
  const gatewayUrl = sourceEnv.NUANU_GATEWAY_URL || mode.gatewayUrl;
  if (modeName === "dev") {
    assertLocalUrl(apiUrl, "URL");
    assertLocalUrl(gatewayUrl, "gateway URL");
  } else {
    assertProductionUrl(apiUrl, "URL", "https:");
    assertProductionUrl(gatewayUrl, "gateway URL", "wss:");
  }

  env.NUANU_URL = apiUrl;
  env.NUANU_GATEWAY_URL = gatewayUrl;
  // An enrolled credential is the normal path; an explicit key only overrides it.
  const agentKey = sourceEnv[mode.agentKeyEnv] || sourceEnv.NUANU_AGENT_KEY;
  if (agentKey) {
    env.NUANU_AGENT_KEY = agentKey;
    env[mode.agentKeyEnv] = agentKey;
  }
  env.NUANU_ADAPTER = sourceEnv.NUANU_ADAPTER || "claude-code";
  env.NUANU_AGENT_BUS_SCRIPT = roots.agentBusScript;

  return {
    script: roots.workerScript,
    env,
    cwd: options.cwd || process.cwd(),
    banner: workerBanner(mode, env, roots),
    roots,
  };
}

export async function runWorker(options) {
  const launch = buildWorkerLaunch(options.mode, options);
  process.stderr.write(`${launch.banner}\n`);
  if (options.dryRun) return { ...launch, status: 0 };
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launch.script], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ ...launch, status: code ?? 0, signal });
    });
  });
}

function parseArgs(argv) {
  const mode = argv[0];
  if (mode !== "prod" && mode !== "dev") {
    throw new Error(
      "Usage: node scripts/claude/run-worker.mjs <prod|dev> [--dry-run] [--cwd <path>] [--claude-bin <bin>]",
    );
  }
  const options = { mode, cwd: process.cwd(), dryRun: false };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--cwd") {
      const value = argv[++index];
      if (!value) throw new Error("--cwd requires a value");
      options.cwd = path.resolve(value);
    } else if (arg === "--claude-bin") {
      options.claudeBin = argv[++index];
      if (!options.claudeBin) throw new Error("--claude-bin requires a value");
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runWorker(options);
  if (result.status) process.exit(result.status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[claude-worker] ${error.message}`);
    process.exit(1);
  });
}
