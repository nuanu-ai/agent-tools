#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { probeOAuthMetadata } from "./auth.mjs";
import { readHookTrustStatus } from "./hook-status.mjs";
import { modeConfig } from "./modes.mjs";

function usage() {
  console.log(`Usage: node scripts/codex/auth-doctor.mjs [options]

Options:
  --mode prod|dev  Select credentials and the default MCP URL. Defaults to prod.
  --url URL        Override the selected Flow MCP URL.
  --json           Print JSON only.
  -h, --help       Show this help.
`);
}

function parseArgs(argv) {
  const options = { json: false, url: "", mode: "prod" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--url") options.url = argv[++index] || "";
    else if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
    } else if (arg === "--mode") {
      options.mode = argv[++index];
      if (options.mode !== "prod" && options.mode !== "dev") {
        throw new Error("--mode requires prod or dev");
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function diagnoseAuth(options = {}) {
  const mode = modeConfig(options.mode || "prod", options.env || process.env);
  const mcpUrl = options.url || mode.mcpUrl;
  const oauth = await probeOAuthMetadata(mcpUrl, {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  const env = options.env || process.env;
  const tokenPresent = Boolean(env[mode.tokenEnv]);
  const agentKeyPresent = Boolean(env[mode.agentKeyEnv]);
  const hook = await (options.readHookTrustStatus || readHookTrustStatus)({
    codexBin: options.codexBin,
    cwd: options.cwd,
    env,
    pluginId: mode.pluginId,
    timeoutMs: options.hookStatusTimeoutMs,
  });
  return {
    mode: mode.name,
    mcpName: mode.mcpName,
    mcpUrl,
    envReady: tokenPresent || agentKeyPresent,
    tokenPresent,
    agentKeyPresent,
    hookStatus: hook.status,
    hookDetail: hook.detail,
    ...oauth,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const result = await diagnoseAuth(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Flow MCP: ${result.mcpUrl}`);
  console.log(
    `Env auth: ${result.envReady ? "ready" : "not set"} (token=${result.tokenPresent ? "set" : "unset"}, agent key=${result.agentKeyPresent ? "set" : "unset"})`,
  );
  console.log(
    `OAuth metadata: ${result.status}${result.probe ? ` (${result.probe})` : ""}`,
  );
  console.log(
    `Session hook: ${
      result.hookStatus === "review_required"
        ? "review required"
        : result.hookStatus
    }${result.hookDetail ? ` (${result.hookDetail})` : ""}`,
  );
  if (
    result.status === "oauth-disabled" ||
    result.status === "oauth-metadata-missing"
  ) {
    console.log(
      `Next: set ${modeConfig(result.mode).tokenEnv} for interactive Codex or ${modeConfig(result.mode).agentKeyEnv} for workers until Flow exposes MCP OAuth metadata.`,
    );
  } else {
    console.log(
      `Next: run \`npm run codex:auth:${result.mode}\` to open browser OAuth for \`nuanu-flow\`.`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-auth-doctor] ${error.message}`);
    process.exit(1);
  });
}
