import fs from "node:fs/promises";
import path from "node:path";

export const WORKER_DIAGNOSTIC_VERSION = "nuanu.worker-diagnostic.v1";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/;
const MODEL_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$/;
const CATEGORIES = new Set([
  "worker",
  "workspace",
  "repository",
  "runtime",
  "provider",
  "artifact",
  "lease",
  "human_input",
  "delivery",
]);
const LEVELS = new Set(["debug", "info", "warning", "error"]);
const PHASES = new Set([
  "task_claimed",
  "task_workspace_ready",
  "repository_preparing",
  "repository_ready",
  "runtime_starting",
  "runtime_working",
  "provider_request",
  "provider_retry",
  "provider_error",
  "artifact_tool_started",
  "artifact_tool_completed",
  "artifact_tool_failed",
  "artifact_tool_rejected",
  "artifact_upload_started",
  "artifact_upload_verified",
  "waiting_for_human",
  "lease_renewed",
  "lease_lost",
  "terminal_delivery_started",
  "terminal_delivery_retrying",
  "terminal_delivery_acknowledged",
  "terminal_delivery_fenced",
  "terminal_delivery_unacknowledged",
  "task_completed",
  "task_failed",
]);
const TERMINAL_PHASES = new Set(["task_completed", "task_failed"]);

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function sanitizeDiagnosticMessage(value) {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bnuanu_(?:flow|join)_[A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key))=\S+/gi, "$1=[redacted]")
    .replace(/\/(?:Users|home|private|var|tmp)\/[^\s,;:)]+/g, "[path]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, 500) : null;
}

export function normalizeWorkerDiagnostic(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.schema_version !== WORKER_DIAGNOSTIC_VERSION) return null;
  const occurredAt = isoTimestamp(input.occurred_at);
  const taskId = identifier(input.task_id);
  const runId = identifier(input.run_id);
  const workerId = identifier(input.worker_id);
  const adapter = identifier(input.adapter);
  const category = typeof input.category === "string" && CATEGORIES.has(input.category) ? input.category : null;
  const phase = typeof input.phase === "string" && PHASES.has(input.phase) ? input.phase : null;
  const level = typeof input.level === "string" && LEVELS.has(input.level) ? input.level : null;
  if (!occurredAt || !taskId || !runId || !workerId || !adapter || !category || !phase || !level) return null;

  const result = {
    schema_version: WORKER_DIAGNOSTIC_VERSION,
    occurred_at: occurredAt,
    task_id: taskId,
    run_id: runId,
    worker_id: workerId,
    adapter,
    category,
    phase,
    level,
  };
  for (const key of ["provider", "error_code", "session_id", "turn_id", "artifact_kind", "artifact_role"]) {
    const normalized = identifier(input[key]);
    if (normalized) result[key] = normalized;
  }
  if (typeof input.model === "string" && MODEL_IDENTIFIER.test(input.model)) result.model = input.model;
  for (const [key, min, max] of [
    ["attempt", 1, 1000],
    ["max_attempts", 1, 1000],
    ["status_code", 0, 599],
    ["size", 0, Number.MAX_SAFE_INTEGER],
  ]) {
    const normalized = integer(input[key], min, max);
    if (normalized !== null) result[key] = normalized;
  }
  if (typeof input.retryable === "boolean") result.retryable = input.retryable;
  const message = sanitizeDiagnosticMessage(input.safe_message);
  if (message) result.safe_message = message;
  return result;
}

function assertIdentity(name, value) {
  const normalized = identifier(value);
  if (!normalized) throw new Error(`A valid ${name} is required`);
  return normalized;
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function readJournal(filePath) {
  let body;
  try {
    body = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const normalized = normalizeWorkerDiagnostic(JSON.parse(line));
      if (normalized) records.push(normalized);
    } catch {
      // Malformed local diagnostics fail closed instead of blocking the reader.
    }
  }
  return records;
}

export function createTaskLogStore({
  rootDir,
  workerId,
  maxRecords = 200,
  maxRecordBytes = 4096,
  ttlMs = 7 * 24 * 60 * 60 * 1000,
  now = Date.now,
} = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new Error("An absolute worker log rootDir is required");
  }
  const safeWorkerId = assertIdentity("worker id", workerId);
  const workerDirectory = path.join(rootDir, safeWorkerId);
  const chains = new Map();

  const pathForTask = (taskId) => path.join(workerDirectory, `${assertIdentity("task id", taskId)}.jsonl`);

  const serialize = (operation, taskId) => {
    const prior = chains.get(taskId) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    chains.set(taskId, next);
    return next.finally(() => {
      if (chains.get(taskId) === next) chains.delete(taskId);
    });
  };

  const store = {
    pathForTask,

    async append(input) {
      const record = normalizeWorkerDiagnostic(input);
      if (!record || record.worker_id !== safeWorkerId) return null;
      const encoded = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(encoded) > maxRecordBytes) return null;
      return serialize(async () => {
        await ensurePrivateDirectory(rootDir);
        await ensurePrivateDirectory(workerDirectory);
        const filePath = pathForTask(record.task_id);
        const records = [...(await readJournal(filePath)), record].slice(-Math.max(1, maxRecords));
        const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporary, records.map((item) => JSON.stringify(item)).join("\n") + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, filePath);
        return record;
      }, record.task_id);
    },

    async read({ taskId, limit = maxRecords } = {}) {
      const safeTaskId = assertIdentity("task id", taskId);
      const records = await readJournal(pathForTask(safeTaskId));
      return records.slice(-Math.max(1, Math.min(Number(limit) || maxRecords, maxRecords)));
    },

    async list() {
      let entries;
      try {
        entries = await fs.readdir(workerDirectory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const result = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const candidate = entry.name.slice(0, -".jsonl".length);
        if (!identifier(candidate)) continue;
        const stat = await fs.stat(path.join(workerDirectory, entry.name));
        if (now() - stat.mtimeMs <= ttlMs) result.push({ task_id: candidate, updated_at: stat.mtime.toISOString() });
      }
      return result.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },

    async cleanup() {
      let entries;
      try {
        entries = await fs.readdir(workerDirectory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const removed = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const filePath = path.join(workerDirectory, entry.name);
        const stat = await fs.stat(filePath);
        if (now() - stat.mtimeMs <= ttlMs) continue;
        await fs.unlink(filePath);
        removed.push(entry.name);
      }
      return removed;
    },

    async export({ taskId, destination }) {
      if (typeof destination !== "string" || !path.isAbsolute(destination)) {
        throw new Error("An absolute export destination is required");
      }
      const records = await store.read({ taskId });
      await ensurePrivateDirectory(path.dirname(destination));
      await fs.writeFile(destination, records.map((item) => JSON.stringify(item)).join("\n") + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await fs.chmod(destination, 0o600);
      return destination;
    },

    async *follow({ taskId, after = 0, pollIntervalMs = 250, signal } = {}) {
      let cursor = Math.max(0, Number(after) || 0);
      while (!signal?.aborted) {
        const records = await store.read({ taskId });
        while (cursor < records.length) {
          const record = records[cursor++];
          yield record;
          if (TERMINAL_PHASES.has(record.phase)) return;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.max(10, pollIntervalMs));
          timer.unref?.();
        });
      }
    },
  };
  return store;
}

export async function readTaskLogs(options) {
  const store = createTaskLogStore(options);
  return store.read({ taskId: options.taskId, limit: options.limit });
}
