import os from "node:os";

import { createDefaultCredentialStore } from "./credentials.mjs";

function required(name, value) {
  const v = value;
  if (!v) {
    console.error(`[nuanu-worker] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function int(env, name, def) {
  const v = env[name];
  const n = v == null || v === "" ? def : Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(env, name, def = false) {
  const v = env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Gateway WS endpoint derived from the API base URL: in a deployed stack the
 *  proxy serves both under one host (`https://host/api` →
 *  `wss://host/live/agent-gateway`); a localhost API means the Live server runs
 *  standalone on its own port. NUANU_GATEWAY_URL always wins when set. */
function deriveGatewayUrl(baseUrl) {
  const local = "ws://localhost:3100/live/agent-gateway";
  try {
    const u = new URL(baseUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return local;
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${u.host}/live/agent-gateway`;
  } catch {
    return local;
  }
}

/**
 * Worker configuration from explicit env overrides or an enrolled credential.
 * The base URL must include `/api`.
 * Adapter "claude" wraps `claude -p`; "codex-exec" wraps `codex exec`;
 * "codex-app-server" drives Codex App Server over JSON-RPC; "command" runs an
 * arbitrary shell command (prompt on stdin, answer on stdout).
 */
export function loadConfig({ env = process.env, credentialStore = createDefaultCredentialStore() } = {}) {
  const stored = !env.NUANU_URL || !env.NUANU_AGENT_KEY ? credentialStore.loadSync() : null;
  const baseUrl = required("NUANU_URL", env.NUANU_URL || stored?.baseUrl).replace(/\/+$/, "");
  return {
    baseUrl,
    agentKey: required("NUANU_AGENT_KEY", env.NUANU_AGENT_KEY || stored?.agentKey),
    workerId: env.NUANU_WORKER_ID || `worker-${os.hostname()}-${process.pid}`,
    maxConcurrency: Math.max(1, int(env, "NUANU_MAX_CONCURRENCY", 1)),
    // "poll" (HTTP long/short-poll, zero infra) | "gateway" (WS wake + HTTP claim).
    transport: (env.NUANU_TRANSPORT || "poll").toLowerCase(),
    gatewayUrl: env.NUANU_GATEWAY_URL || deriveGatewayUrl(baseUrl),
    pollIntervalMs: Math.max(500, int(env, "NUANU_POLL_INTERVAL_MS", 2000)),
    heartbeatIntervalMs: Math.max(5000, int(env, "NUANU_HEARTBEAT_INTERVAL_MS", 15000)),
    lockSeconds: Math.max(30, int(env, "NUANU_LOCK_SECONDS", 300)),
    adapter: {
      type: (env.NUANU_ADAPTER || "claude").toLowerCase(),
      claudeBin: env.NUANU_CLAUDE_BIN || "claude",
      claudeArgs: (env.NUANU_CLAUDE_ARGS || "-p --output-format json").split(/\s+/).filter(Boolean),
      claudeSkipPermissions: bool(env, "NUANU_CLAUDE_SKIP_PERMISSIONS", false),
      claudeCwd: env.NUANU_CLAUDE_CWD || os.tmpdir(),
      codexBin: env.NUANU_CODEX_BIN || "codex",
      codexArgs: (env.NUANU_CODEX_ARGS || "exec --skip-git-repo-check").split(/\s+/).filter(Boolean),
      codexCwd: env.NUANU_CODEX_CWD || os.tmpdir(),
      codexAppServerArgs: (env.NUANU_CODEX_APP_SERVER_ARGS || "app-server --stdio")
        .split(/\s+/)
        .filter(Boolean),
      codexAgentKeyEnv: env.NUANU_CODEX_AGENT_KEY_ENV || "NUANU_AGENT_KEY",
      codexAppServerApprovalMode: (env.NUANU_CODEX_APP_SERVER_APPROVAL_MODE || "deny").toLowerCase(),
      codexAppServerApprovalPolicy: env.NUANU_CODEX_APP_SERVER_APPROVAL_POLICY || "never",
      command: env.NUANU_ADAPTER_CMD || "",
      timeoutMs: Math.max(10000, int(env, "NUANU_ADAPTER_TIMEOUT_MS", 300000)),
    },
  };
}
