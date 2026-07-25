#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { MODES, modeConfig, runCodex } from "./modes.mjs";

const KEYCHAIN_SERVICE = "nuanu-flow-codex";
const AUTH_ENV_NAMES = Object.values(MODES).flatMap((mode) => [
  mode.tokenEnv,
  mode.agentKeyEnv,
  mode.workspaceEnv,
]);

export function keychainAccount(mode) {
  if (mode !== "prod" && mode !== "dev") {
    throw new Error(`Unknown Nuanu Flow mode "${mode}"`);
  }
  return `nuanu-flow-codex-${mode}`;
}

export const systemKeychain = {
  async get({ service, account }) {
    if (process.platform !== "darwin") return null;
    const result = spawnSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return result.status === 0 ? String(result.stdout).trim() || null : null;
  },
  async set({ service, account, token }) {
    if (process.platform !== "darwin") {
      throw new Error("macOS Keychain is not available on this platform");
    }
    const result = spawnSync(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ],
      {
        encoding: "utf8",
        input: `${token}\n`,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Could not store token in macOS Keychain: ${String(result.stderr).trim()}`,
      );
    }
  },
};

export async function resolveModeCredentials(
  modeName,
  env = process.env,
  keychain = systemKeychain,
) {
  const mode = modeConfig(modeName, env);
  const childEnv = { ...env };
  for (const name of AUTH_ENV_NAMES) delete childEnv[name];

  const token = env[mode.tokenEnv] || "";
  const agentKey = env[mode.agentKeyEnv] || "";
  const workspace = env[mode.workspaceEnv] || "";
  let source = "missing";
  let selectedToken = token;
  if (token) source = "environment-token";
  else if (agentKey) source = "environment-agent-key";
  else {
    selectedToken =
      (await keychain?.get?.({
        service: KEYCHAIN_SERVICE,
        account: keychainAccount(modeName),
      })) || "";
    if (selectedToken) source = "keychain";
  }

  if (selectedToken) childEnv[mode.tokenEnv] = selectedToken;
  if (agentKey) childEnv[mode.agentKeyEnv] = agentKey;
  if (workspace) childEnv[mode.workspaceEnv] = workspace;

  return {
    env: childEnv,
    report: {
      mode: modeName,
      source,
      tokenPresent: Boolean(selectedToken),
      agentKeyPresent: Boolean(agentKey),
      workspacePresent: Boolean(workspace),
      persistent: source === "keychain",
    },
  };
}

export function metadataCandidates(rawUrl) {
  const url = new URL(rawUrl);
  const origin = url.origin;
  const parentPath = url.pathname.replace(/\/[^/]*$/, "");
  return [
    `${origin}/.well-known/oauth-protected-resource`,
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}${parentPath}/.well-known/oauth-protected-resource`,
    `${origin}${parentPath}/.well-known/oauth-authorization-server`,
  ];
}

export function classifyOAuthProbes(probes) {
  const success = probes.find(
    (probe) =>
      probe.status >= 200 &&
      probe.status < 300 &&
      probe.json &&
      typeof probe.json === "object",
  );
  if (success) {
    return { status: "oauth-metadata-available", probe: success.url };
  }
  const disabled = probes.find(
    (probe) => probe.json?.error === "oauth_disabled",
  );
  if (disabled) return { status: "oauth-disabled", probe: disabled.url };
  return { status: "oauth-metadata-missing", probe: "" };
}

async function fetchJsonProbe(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // OAuth discovery endpoints should return JSON; retain status for diagnosis.
  }
  return {
    url,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    json,
  };
}

export async function probeOAuthMetadata(rawUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 5000;
  const probes = [];
  for (const candidate of metadataCandidates(rawUrl)) {
    try {
      probes.push(
        await fetchJsonProbe(candidate, {
          fetchImpl,
          timeoutMs,
        }),
      );
    } catch (error) {
      probes.push({
        url: candidate,
        status: 0,
        contentType: "",
        json: null,
        error: error.message,
      });
    }
  }
  return {
    ...classifyOAuthProbes(probes),
    probes,
  };
}

export async function probeEndpoint(url, timeoutMs = 5000) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return {
      url,
      status: "reachable",
      httpStatus: response.status,
    };
  } catch (error) {
    const timedOut =
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      /timed out/i.test(error.message);
    return {
      url,
      status: timedOut ? "timeout" : "unreachable",
      error: error.message,
    };
  }
}

export async function readMcpAuthStatus(modeName, options = {}) {
  const mode = modeConfig(modeName, options.env || process.env);
  const result = runCodex(
    ["--profile", mode.profile, "mcp", "list", "--json"],
    {
      codexBin: options.codexBin,
      cwd: options.cwd,
      env: options.env,
    },
  );
  let servers;
  try {
    servers = JSON.parse(result.stdout);
  } catch {
    return "unknown";
  }
  const status = servers.find((server) => server.name === mode.mcpName)
    ?.auth_status;
  return ["o_auth", "not_logged_in", "unsupported"].includes(status)
    ? status
    : "unknown";
}

function readHiddenToken(promptText) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    const input = process.stdin;
    const previousRaw = input.isRaw;
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (character) => {
      if (character === "\u0003") {
        cleanup();
        process.kill(process.pid, "SIGINT");
        return;
      }
      if (character === "\r" || character === "\n") {
        process.stdout.write("\n");
        cleanup();
        resolve(value);
        return;
      }
      if (character === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += character;
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
    };
    input.on("data", onData);
  });
}

export async function authenticateMode(modeName, options = {}) {
  const mode = modeConfig(modeName, options.env || process.env);
  const keychain = options.keychain || systemKeychain;
  if (!options.storeToken) {
    const oauthStatus = await readMcpAuthStatus(modeName, options);
    if (oauthStatus === "o_auth") {
      return { mode: modeName, ready: true, source: "oauth" };
    }
    if (oauthStatus === "not_logged_in" && !options.check) {
      runCodex(
        ["--profile", mode.profile, "mcp", "login", mode.mcpName],
        {
          codexBin: options.codexBin,
          cwd: options.cwd,
          env: options.env,
          stdio: "inherit",
        },
      );
      const verified = await readMcpAuthStatus(modeName, options);
      return {
        mode: modeName,
        ready: verified === "o_auth",
        source: verified === "o_auth" ? "oauth" : "missing",
      };
    }
    const credentials = await resolveModeCredentials(
      modeName,
      options.env || process.env,
      keychain,
    );
    if (credentials.report.source !== "missing") {
      return {
        mode: modeName,
        ready: true,
        source: credentials.report.source,
      };
    }
  }

  if (options.check) {
    return { mode: modeName, ready: false, source: "missing" };
  }
  if (process.platform !== "darwin") {
    throw new Error(
      `Persistent fallback auth is unavailable on this platform. Set ${mode.tokenEnv} or ${mode.agentKeyEnv}.`,
    );
  }
  const readToken = options.readToken || readHiddenToken;
  const token = await readToken(`Token for ${mode.label}: `);
  if (!token) throw new Error("No token provided");
  await keychain.set({
    service: KEYCHAIN_SERVICE,
    account: keychainAccount(modeName),
    token,
  });
  return { mode: modeName, ready: true, source: "keychain" };
}

function parseArgs(argv) {
  const mode = argv[0];
  if (mode !== "prod" && mode !== "dev") {
    throw new Error("Usage: node scripts/codex/auth.mjs <prod|dev> [options]");
  }
  const options = { mode };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--store-token") options.storeToken = true;
    else if (arg === "--codex-bin") {
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
    console.log(`Usage: node scripts/codex/auth.mjs <prod|dev> [options]

Options:
  --check          Report readiness without prompting or changing credentials.
  --store-token    Replace the selected mode's macOS Keychain fallback token.
  --codex-bin BIN  Codex binary to execute. Defaults to "codex".
`);
    return;
  }
  const result = await authenticateMode(options.mode, options);
  console.log(
    `${options.mode}: ${result.ready ? "ready" : "not ready"} (${result.source})`,
  );
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[codex-auth] ${error.message}`);
    process.exit(1);
  });
}
