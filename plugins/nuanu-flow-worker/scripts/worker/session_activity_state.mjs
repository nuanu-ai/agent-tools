import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;
const MAX_RECENT_EVENTS = 50;
const MAX_STATE_BYTES = 128 * 1024;
const DEFAULT_STALE_AFTER_MS = 90_000;
const HEARTBEAT_WRITE_INTERVAL_MS = 60_000;
const LOCK_STALE_MS = 60_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 250;
const MAX_EVENT_FILES = 50;
const MAX_EVENT_BYTES = 4096;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const CONNECTIONS = new Set(["connected", "disconnected", "stopped"]);
const EVENT_KINDS = new Set([
  "worker.connected",
  "worker.disconnected",
  "worker.stopped",
  "task.claimed",
  "task.started",
  "task.progress",
  "task.attention",
  "task.completed",
  "task.failed",
  "task.requeued",
]);
const SIGNIFICANT_KINDS = new Set([
  "worker.disconnected",
  "task.claimed",
  "task.attention",
  "task.completed",
  "task.failed",
  "task.requeued",
]);

function validSessionId(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeIdentifier(value, maxLength = 100) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._:-]/g, "")
    .slice(0, maxLength);
}

function safeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/nuanu_(?:join|flow)_[A-Za-z0-9_-]{16,}/gi, "[redacted]")
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gi, "[redacted]")
      .replace(/\b(authorization|api[_ -]?key|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, "[url]")
      .trim()
      .slice(0, maxLength)
  );
}

function safeUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeEvent(input, { ownerSessionId, now = Date.now, id = randomUUID } = {}) {
  const kind = EVENT_KINDS.has(input?.kind) ? input.kind : "";
  if (!validSessionId(ownerSessionId) || !kind) return null;
  const durationMs = Number(input.duration_ms);
  return {
    version: STATE_VERSION,
    id: safeIdentifier(input.id || id()),
    owner_session_id: ownerSessionId,
    worker_id: safeIdentifier(input.worker_id),
    agent_id: safeIdentifier(input.agent_id),
    agent_name: safeText(input.agent_name, 80),
    task_id: safeIdentifier(input.task_id),
    run_id: safeIdentifier(input.run_id),
    kind,
    severity:
      kind === "task.attention"
        ? "attention"
        : ["task.failed", "task.requeued", "worker.disconnected"].includes(kind)
          ? "error"
          : "info",
    occurred_at: new Date(now()).toISOString(),
    safe_title: safeText(input.safe_title, 120),
    safe_summary: safeText(input.safe_summary, 200),
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { duration_ms: Math.round(durationMs) } : {}),
    ...(safeUrl(input.flow_url) ? { flow_url: safeUrl(input.flow_url) } : {}),
  };
}

function sessionDirectory(activityDirectory, sessionId) {
  return validSessionId(sessionId) ? path.join(activityDirectory, "sessions", sessionId) : "";
}

function statePath(activityDirectory, sessionId) {
  const directory = sessionDirectory(activityDirectory, sessionId);
  return directory ? path.join(directory, "state.json") : "";
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireSessionLock(activityDirectory, sessionId) {
  const directory = sessionDirectory(activityDirectory, sessionId);
  if (!directory) return null;
  await ensurePrivateDirectory(path.dirname(directory));
  await ensurePrivateDirectory(directory);
  const lockPath = path.join(directory, "activity.lock");
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      return async () => {
        try {
          await fs.rm(lockPath, { recursive: true, force: true });
        } catch {
          // Local visibility locks are best-effort and never affect task execution.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      await delay(10);
    }
  }
  return null;
}

function emptyState({ ownerSessionId, workerId, writerInstanceId, agentId, agentName, nowMs }) {
  return {
    version: STATE_VERSION,
    owner_session_id: ownerSessionId,
    sequence: 0,
    updated_at: new Date(nowMs).toISOString(),
    worker: {
      worker_id: safeIdentifier(workerId),
      writer_instance_id: safeIdentifier(writerInstanceId),
      agent_id: safeIdentifier(agentId),
      agent_name: safeText(agentName, 80),
      connection: "disconnected",
      last_heartbeat_at: null,
    },
    active_tasks: [],
    last_terminal_task: null,
    recent_events: [],
  };
}

function validState(value, ownerSessionId) {
  return Boolean(
    value &&
    value.version === STATE_VERSION &&
    value.owner_session_id === ownerSessionId &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    value.worker &&
    Array.isArray(value.active_tasks) &&
    Array.isArray(value.recent_events)
  );
}

async function readStoredState(activityDirectory, sessionId) {
  const filePath = statePath(activityDirectory, sessionId);
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return null;
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return validState(parsed, sessionId) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function boundedState(state) {
  state.recent_events = state.recent_events.slice(-MAX_RECENT_EVENTS);
  let encoded = JSON.stringify(state);
  while (Buffer.byteLength(encoded) > MAX_STATE_BYTES && state.recent_events.length) {
    state.recent_events.shift();
    encoded = JSON.stringify(state);
  }
  if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Session activity state exceeds its size limit");
  return encoded;
}

async function writeState(activityDirectory, sessionId, state) {
  const directory = sessionDirectory(activityDirectory, sessionId);
  await ensurePrivateDirectory(path.dirname(directory));
  await ensurePrivateDirectory(directory);
  const target = statePath(activityDirectory, sessionId);
  const temporary = path.join(directory, `.state.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${boundedState(state)}\n`, { flag: "wx", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

async function removeFileQuietly(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function pruneEventFiles(eventDirectory, nowMs, retentionMs) {
  let entries;
  try {
    entries = await fs.readdir(eventDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const overflow = Math.max(0, files.length - MAX_EVENT_FILES);
  for (let index = 0; index < files.length; index += 1) {
    const filePath = path.join(eventDirectory, files[index]);
    try {
      const stat = await fs.stat(filePath);
      if (index < overflow || nowMs - stat.mtimeMs > retentionMs) await removeFileQuietly(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export {
  STATE_VERSION,
  MAX_RECENT_EVENTS,
  MAX_STATE_BYTES,
  DEFAULT_STALE_AFTER_MS,
  HEARTBEAT_WRITE_INTERVAL_MS,
  MAX_EVENT_FILES,
  MAX_EVENT_BYTES,
  DEFAULT_RETENTION_MS,
  STALE_CLAIM_MS,
  CONNECTIONS,
  EVENT_KINDS,
  SIGNIFICANT_KINDS,
  validSessionId,
  safeIdentifier,
  safeText,
  safeUrl,
  normalizeEvent,
  sessionDirectory,
  statePath,
  ensurePrivateDirectory,
  acquireSessionLock,
  emptyState,
  readStoredState,
  writeState,
  removeFileQuietly,
  pruneEventFiles,
};
