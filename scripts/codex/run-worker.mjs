#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODES,
  REPO_ROOT,
  codexModeHome,
  codexHome as resolveCodexHome,
  modeConfig,
} from "./modes.mjs";
import { ensureSharedCodexAuth } from "./setup.mjs";
import { preflight } from "./status.mjs";

const WORKER_SCRIPT = path.join(
  REPO_ROOT,
  "plugins/nuanu-flow/scripts/worker/worker.mjs",
);

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
  const expectedOrigin = `${protocol}//flow.nuanu.com`;
  if (
    url.protocol !== protocol ||
    url.hostname !== "flow.nuanu.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Production worker ${label} must use ${expectedOrigin}: ${rawUrl}`,
    );
  }
}

function workerBanner(mode, env) {
  return [
    "=".repeat(72),
    `NUANU FLOW ${mode.label} WORKER`,
    `API: ${env.NUANU_URL}`,
    `Gateway: ${env.NUANU_GATEWAY_URL}`,
    `Adapter: ${env.NUANU_ADAPTER}`,
    `Codex home: ${env.CODEX_HOME}`,
    "=".repeat(72),
  ].join("\n");
}

export function buildWorkerLaunch(modeName, options = {}) {
  const sourceEnv = options.env || process.env;
  const mode = modeConfig(modeName, sourceEnv);
  const agentKey = sourceEnv[mode.agentKeyEnv];
  if (!agentKey) {
    throw new Error(
      `${mode.agentKeyEnv} is required for the ${mode.label} worker.`,
    );
  }
  const env = { ...sourceEnv };
  const opposite = modeName === "dev" ? MODES.prod : MODES.dev;
  delete env[opposite.tokenEnv];
  delete env[opposite.agentKeyEnv];
  delete env[opposite.workspaceEnv];
  delete env[mode.tokenEnv];

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
  env.NUANU_AGENT_KEY = agentKey;
  env[mode.agentKeyEnv] = agentKey;
  env.NUANU_ADAPTER = sourceEnv.NUANU_ADAPTER || "codex-app-server";
  env.NUANU_CODEX_APP_SERVER_ARGS =
    sourceEnv.NUANU_CODEX_APP_SERVER_ARGS || "app-server --stdio";
  env.CODEX_HOME = codexModeHome(modeName, {
    codexHome: options.codexHome,
    env: sourceEnv,
  });
  env.NUANU_CODEX_BASE_HOME = resolveCodexHome({
    codexHome: options.codexHome,
    env: sourceEnv,
  });
  env.NUANU_CODEX_AGENT_KEY_ENV = mode.agentKeyEnv;
  env.NUANU_CODEX_CWD =
    sourceEnv.NUANU_CODEX_CWD || options.cwd || process.cwd();

  return {
    script: options.workerScript || WORKER_SCRIPT,
    env,
    cwd: options.cwd || process.cwd(),
    banner: workerBanner(mode, env),
  };
}

function parseArgs(argv) {
  const mode = argv[0];
  if (mode !== "prod" && mode !== "dev") {
    throw new Error(
      "Usage: node scripts/codex/run-worker.mjs <prod|dev> [options]",
    );
  }
  const options = {
    mode,
    cwd: process.cwd(),
    dryRun: false,
    codexBin: "codex",
  };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
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

export async function runWorker(options) {
  const launch = buildWorkerLaunch(options.mode, options);
  launch.env.NUANU_CODEX_BIN =
    options.codexBin || launch.env.NUANU_CODEX_BIN || "codex";
  if (!options.dryRun) {
    const baseHome = resolveCodexHome({
      codexHome: options.codexHome,
      env: options.env,
    });
    await ensureSharedCodexAuth(baseHome, launch.env.CODEX_HOME);
    await preflight(options.mode, {
      repoRoot: options.repoRoot,
      buildRoot: options.buildRoot,
      codexHome: baseHome,
      codexBin: options.codexBin,
      env: launch.env,
      worker: true,
    });
  }
  console.log(launch.banner);
  if (options.dryRun) return 0;
  const child = spawn(process.execPath, [launch.script], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: "inherit",
  });
  const forwardSignal = (signal) => {
    if (child.exitCode == null) child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    if (result.status != null) return result.status;
    return result.signal === "SIGINT" ? 130 : 143;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/codex/run-worker.mjs <prod|dev> [options]

Options:
  --cwd DIR          Set the worker and Codex task working directory.
  --dry-run          Print selected mode without starting the worker.
  --codex-bin BIN    Codex binary to execute. Defaults to "codex".
`);
    return;
  }
  process.exitCode = await runWorker(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[worker-${process.argv[2] || "mode"}] ${error.message}`);
    process.exit(1);
  });
}
