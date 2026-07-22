import os from "node:os";

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[nuanu-worker] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function int(name, def) {
  const v = process.env[name];
  const n = v == null || v === "" ? def : Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

/**
 * Worker configuration, entirely from env. The base URL must include `/api`.
 * Adapter "claude" wraps `claude -p`; "command" runs an arbitrary shell command
 * (prompt on stdin, answer on stdout) — the universal escape hatch.
 */
export function loadConfig() {
  const baseUrl = required("NUANU_URL").replace(/\/+$/, "");
  return {
    baseUrl,
    agentKey: required("NUANU_AGENT_KEY"),
    workerId: process.env.NUANU_WORKER_ID || `worker-${os.hostname()}-${process.pid}`,
    maxConcurrency: Math.max(1, int("NUANU_MAX_CONCURRENCY", 1)),
    // "poll" (HTTP long/short-poll, zero infra) | "gateway" (WS wake + HTTP claim).
    transport: (process.env.NUANU_TRANSPORT || "poll").toLowerCase(),
    gatewayUrl: process.env.NUANU_GATEWAY_URL || "ws://localhost:3100/live/agent-gateway",
    pollIntervalMs: Math.max(500, int("NUANU_POLL_INTERVAL_MS", 2000)),
    heartbeatIntervalMs: Math.max(5000, int("NUANU_HEARTBEAT_INTERVAL_MS", 15000)),
    lockSeconds: Math.max(30, int("NUANU_LOCK_SECONDS", 300)),
    adapter: {
      type: (process.env.NUANU_ADAPTER || "claude").toLowerCase(),
      claudeBin: process.env.NUANU_CLAUDE_BIN || "claude",
      claudeArgs: (process.env.NUANU_CLAUDE_ARGS || "-p --output-format json")
        .split(/\s+/)
        .filter(Boolean),
      claudeSkipPermissions: bool("NUANU_CLAUDE_SKIP_PERMISSIONS", false),
      claudeCwd: process.env.NUANU_CLAUDE_CWD || os.tmpdir(),
      codexBin: process.env.NUANU_CODEX_BIN || "codex",
      codexArgs: (process.env.NUANU_CODEX_ARGS || "exec --skip-git-repo-check")
        .split(/\s+/)
        .filter(Boolean),
      codexCwd: process.env.NUANU_CODEX_CWD || os.tmpdir(),
      command: process.env.NUANU_ADAPTER_CMD || "",
      timeoutMs: Math.max(10000, int("NUANU_ADAPTER_TIMEOUT_MS", 300000)),
    },
  };
}
