import os from "node:os";
import path from "node:path";

import { createDefaultCredentialStore } from "./credentials.mjs";
import { resolveBrowserQaPlaywrightModule } from "./qa_runtime.mjs";
import { defaultActivityDirectory } from "./session_activity.mjs";

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
 * Adapter "claude-code" wraps `claude -p`; "codex-exec" wraps `codex exec`;
 * "codex-app-server" drives Codex App Server over JSON-RPC; "command" runs an
 * arbitrary shell command (prompt on stdin, answer on stdout).
 */
export function loadConfig({
  env = process.env,
  credentialStore = createDefaultCredentialStore({ profile: env.NUANU_WORKER_PROFILE }),
  resolveBrowserQaModule = resolveBrowserQaPlaywrightModule,
} = {}) {
  const stored = !env.NUANU_URL || !env.NUANU_AGENT_KEY ? credentialStore.loadSync() : null;
  const baseUrl = required("NUANU_URL", env.NUANU_URL || stored?.baseUrl).replace(/\/+$/, "");
  const repositoryRoot = env.NUANU_REPOSITORY_ROOT || path.join(os.homedir(), ".cache", "nuanu-flow");
  const adapterType = (env.NUANU_ADAPTER || "claude-code").toLowerCase();
  const capabilities = ["lease_renewal_v1", "checkpoint_v1", "repository_read_write_v1", "human_input_v1"];
  if (adapterType === "acp") capabilities.push("acp_v1");
  if (["codex-app-server", "app-server", "codex_app_server", "app_server"].includes(adapterType)) {
    capabilities.push("artifact_file_publish_v1", "artifact_media_constraints_v1");
  }
  const browserQaEnabled = bool(env, "NUANU_BROWSER_QA", false);
  const browserQaPlaywrightModule = browserQaEnabled ? resolveBrowserQaModule({ env }) : "";
  if (browserQaEnabled) capabilities.push("browser_qa_v1");
  for (const capability of (env.NUANU_WORKER_CAPABILITIES || "").split(",").map((value) => value.trim())) {
    if (capability && !capabilities.includes(capability)) capabilities.push(capability);
  }
  return {
    baseUrl,
    agentKey: required("NUANU_AGENT_KEY", env.NUANU_AGENT_KEY || stored?.agentKey),
    workerId: env.NUANU_WORKER_ID || `worker-${os.hostname()}-${process.pid}`,
    maxConcurrency: Math.max(1, int(env, "NUANU_MAX_CONCURRENCY", 1)),
    // "poll" (HTTP long/short-poll, zero infra) | "gateway" (WS wake + HTTP claim).
    transport: (env.NUANU_TRANSPORT || "poll").toLowerCase(),
    gatewayUrl: env.NUANU_GATEWAY_URL || deriveGatewayUrl(baseUrl),
    // Exact absolute path resolved by the paired plugin installer/launcher.
    // The worker never guesses another plugin's cache directory.
    agentBusScript: env.NUANU_AGENT_BUS_SCRIPT || "",
    // Optional hostname-only bridge for managed workers running in a local
    // container while the task-scoped MCP endpoint lives on the host.
    internalMcpHostname: env.NUANU_INTERNAL_MCP_HOSTNAME || "",
    browserQaPlaywrightModule,
    pollIntervalMs: Math.max(500, int(env, "NUANU_POLL_INTERVAL_MS", 2000)),
    heartbeatIntervalMs: Math.max(5000, int(env, "NUANU_HEARTBEAT_INTERVAL_MS", 15000)),
    capabilities,
    debug: bool(env, "NUANU_WORKER_DEBUG", false),
    lockSeconds: Math.max(30, int(env, "NUANU_LOCK_SECONDS", 300)),
    requestTimeoutMs: Math.max(1000, int(env, "NUANU_REQUEST_TIMEOUT_MS", 30_000)),
    artifactMaxBytes: Math.max(1, int(env, "NUANU_ARTIFACT_MAX_BYTES", 5 * 1024 * 1024)),
    taskWorkspace: {
      root: env.NUANU_TASK_WORKSPACE_ROOT || path.join(os.tmpdir(), "nuanu-flow-task-workspaces"),
      ttlMs: Math.max(60_000, int(env, "NUANU_TASK_WORKSPACE_TTL_MS", 24 * 60 * 60 * 1000)),
    },
    diagnostics: {
      rootDir: env.NUANU_WORKER_LOG_DIR || path.join(repositoryRoot, "worker-logs"),
      maxRecords: Math.max(10, int(env, "NUANU_WORKER_LOG_MAX_RECORDS", 200)),
      maxRecordBytes: Math.max(512, int(env, "NUANU_WORKER_LOG_MAX_RECORD_BYTES", 4096)),
      ttlMs: Math.max(60_000, int(env, "NUANU_WORKER_LOG_TTL_MS", 7 * 24 * 60 * 60 * 1000)),
    },
    activity: {
      directory: defaultActivityDirectory(env),
      ownerSessionId: env.NUANU_OWNER_SESSION_ID || env.CODEX_THREAD_ID || "",
      agentId: env.NUANU_AGENT_ID || stored?.agent?.id || "",
      agentName: env.NUANU_AGENT_NAME || stored?.agent?.display_name || "Remote agent",
    },
    repository: {
      cacheDir: env.NUANU_REPOSITORY_CACHE_DIR || path.join(repositoryRoot, "repositories"),
      worktreeDir: env.NUANU_REPOSITORY_WORKTREE_DIR || path.join(repositoryRoot, "worktrees"),
    },
    adapter: {
      type: adapterType,
      acpBin: env.NUANU_ACP_BIN || "codex-acp",
      acpArgs: (env.NUANU_ACP_ARGS || "").split(/\s+/).filter(Boolean),
      acpCwd: env.NUANU_ACP_CWD || os.tmpdir(),
      acpPermissionMode: (env.NUANU_ACP_PERMISSION_MODE || "auto").toLowerCase(),
      acpAuthMethod: env.NUANU_ACP_AUTH_METHOD || "",
      claudeBin: env.NUANU_CLAUDE_BIN || "claude",
      claudeArgs: (env.NUANU_CLAUDE_ARGS || "-p --output-format stream-json --verbose").split(/\s+/).filter(Boolean),
      claudeSkipPermissions: bool(env, "NUANU_CLAUDE_SKIP_PERMISSIONS", false),
      claudePermissionMode: env.NUANU_CLAUDE_PERMISSION_MODE || "dontAsk",
      claudeAllowedTools: env.NUANU_CLAUDE_ALLOWED_TOOLS || "mcp__plugin_nuanu-flow_mcp__*",
      claudeCwd: env.NUANU_CLAUDE_CWD || os.tmpdir(),
      codexBin: env.NUANU_CODEX_BIN || "codex",
      codexArgs: (env.NUANU_CODEX_ARGS || "exec --skip-git-repo-check").split(/\s+/).filter(Boolean),
      codexCwd: env.NUANU_CODEX_CWD || os.tmpdir(),
      codexAppServerArgs: (env.NUANU_CODEX_APP_SERVER_ARGS || "app-server --stdio").split(/\s+/).filter(Boolean),
      codexAppServerModel: env.NUANU_CODEX_APP_SERVER_MODEL || "",
      codexAppServerReasoningEffort: env.NUANU_CODEX_APP_SERVER_REASONING_EFFORT || "",
      codexAgentKeyEnv: env.NUANU_CODEX_AGENT_KEY_ENV || "NUANU_AGENT_KEY",
      codexAppServerApprovalMode: (env.NUANU_CODEX_APP_SERVER_APPROVAL_MODE || "deny").toLowerCase(),
      codexAppServerApprovalPolicy: env.NUANU_CODEX_APP_SERVER_APPROVAL_POLICY || "never",
      command: env.NUANU_ADAPTER_CMD || "",
      // Image generation plus file validation/publication can legitimately take
      // longer than ten minutes. Keep a finite default and retain the explicit
      // override for deployments that need a tighter task budget.
      timeoutMs: Math.max(10000, int(env, "NUANU_ADAPTER_TIMEOUT_MS", 900000)),
    },
  };
}
