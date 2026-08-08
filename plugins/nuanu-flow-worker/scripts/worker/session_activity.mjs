import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizeWorkerDiagnostic } from "./diagnostic_log.mjs";
import { progressPhaseForDiagnostic } from "./observability.mjs";

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

function eventKindForDiagnostic(record, phase) {
  if (record.phase === "task_claimed") return "task.claimed";
  if (record.phase === "task_completed") return "task.completed";
  if (record.phase === "task_failed") return "task.failed";
  if (
    record.phase === "waiting_for_human" ||
    record.phase.includes("retry") ||
    record.phase.includes("fenced") ||
    record.phase.includes("unacknowledged") ||
    record.level === "warning"
  ) {
    return "task.attention";
  }
  return phase ? "task.progress" : "";
}

function summaryForDiagnostic(record, phase) {
  const explicit = safeText(record.safe_message, 200);
  if (explicit) return explicit;
  const summaries = {
    claimed: "Claimed by remote worker",
    preparing_workspace: "Preparing task workspace",
    preparing_repository: "Preparing repository",
    starting_runtime: "Starting agent runtime",
    working: "Working",
    publishing_artifact: "Publishing Artifact",
    waiting_for_human: "Waiting for human input",
    retrying_provider: "Retrying provider",
    delivering_result: "Delivering result to Flow",
    completed: "Completed and acknowledged by Flow",
    failed: "Failed and acknowledged by Flow",
  };
  if (record.phase.includes("fenced")) return "Task lease was superseded";
  if (record.phase.includes("unacknowledged")) return "Flow did not acknowledge the terminal result";
  return summaries[phase] || "";
}

export function safeTaskTitle(task) {
  return (
    safeText(task?.step_name, 120) ||
    safeText(task?.step_id, 120) ||
    `Task ${safeIdentifier(task?.task_id, 8) || "unknown"}`
  );
}

export function renderActivity(event) {
  const title = event?.safe_title ? ` “${safeText(event.safe_title, 120)}”` : "";
  const summary = safeText(event?.safe_summary, 200);
  if (event?.kind === "worker.connected") return "● Remote agent connected";
  if (event?.kind === "worker.disconnected") return "○ Remote agent disconnected; retrying";
  if (event?.kind === "worker.stopped") return "■ Remote agent stopped";
  if (event?.kind === "task.claimed") return `▶ Claimed${title}`;
  if (event?.kind === "task.started") return `● Running${title}`;
  if (event?.kind === "task.progress") return `├ ${summary || "Working"}`;
  if (event?.kind === "task.attention") return `! Needs attention${title}${summary ? ` — ${summary}` : ""}`;
  if (event?.kind === "task.completed") return `✓ Completed${title}${durationText(event.duration_ms)}`;
  if (event?.kind === "task.failed") return `✕ Failed${title}`;
  if (event?.kind === "task.requeued") return `↻ Requeued${title}`;
  return "";
}

function appendEvent(state, input, nowMs) {
  state.sequence += 1;
  const event = {
    sequence: state.sequence,
    kind: input.kind,
    occurred_at: new Date(nowMs).toISOString(),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.safe_summary ? { safe_summary: input.safe_summary } : {}),
    ...(input.artifact_kind ? { artifact_kind: input.artifact_kind } : {}),
    ...(input.artifact_role ? { artifact_role: input.artifact_role } : {}),
    ...(Number.isSafeInteger(input.size) && input.size >= 0 ? { size: input.size } : {}),
    ...(Number.isSafeInteger(input.duration_ms) && input.duration_ms >= 0 ? { duration_ms: input.duration_ms } : {}),
  };
  state.recent_events.push(event);
  state.recent_events = state.recent_events.slice(-MAX_RECENT_EVENTS);
  return event;
}

export function defaultActivityDirectory(env = process.env) {
  return env.NUANU_ACTIVITY_DATA_DIR || path.join(os.homedir(), ".config", "nuanu-flow", "activity");
}

export function createActivityStore({
  activityDirectory = defaultActivityDirectory(),
  ownerSessionId,
  now = Date.now,
  id = randomUUID,
  retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
  const enabled = validSessionId(ownerSessionId);
  const root = enabled ? sessionDirectory(activityDirectory, ownerSessionId) : "";
  const eventDirectory = root ? path.join(root, "events") : "";
  let sequence = 0;
  return {
    enabled,
    activityDirectory,
    ownerSessionId,
    async publish(input) {
      const nowMs = now();
      const event = normalizeEvent(input, { ownerSessionId, now: () => nowMs, id });
      if (!event) return null;
      await ensurePrivateDirectory(eventDirectory);
      const filename = `${String(nowMs).padStart(13, "0")}-${String(sequence++).padStart(6, "0")}-${event.id}.json`;
      const target = path.join(eventDirectory, filename);
      const temporary = path.join(eventDirectory, `.${filename}.${process.pid}.tmp`);
      const body = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(body) > MAX_EVENT_BYTES)
        throw new Error("Remote-worker activity event exceeds its size limit");
      await fs.writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await pruneEventFiles(eventDirectory, nowMs, retentionMs);
      return event;
    },
  };
}

export function createSessionActivityStore({
  activityDirectory = defaultActivityDirectory(),
  ownerSessionId,
  workerId,
  writerInstanceId = randomUUID(),
  agentId = "",
  agentName = "",
  now = Date.now,
  onEvent = null,
} = {}) {
  const enabled = validSessionId(ownerSessionId);
  let pending = Promise.resolve();
  let deliveryPending = Promise.resolve();
  const inbox = createActivityStore({ activityDirectory, ownerSessionId, now });

  const publishProjectedEvent = async (event, context = {}) => {
    if (!event?.kind) return null;
    const input = {
      kind: event.kind,
      worker_id: workerId,
      agent_id: agentId,
      agent_name: agentName,
      task_id: event.task_id,
      run_id: event.run_id,
      safe_title: context.safeTitle,
      safe_summary: event.safe_summary,
      duration_ms: event.duration_ms,
      flow_url: context.flowUrl,
    };
    if (typeof onEvent === "function") {
      try {
        onEvent(input);
      } catch {
        // Rendering is optional local visibility.
      }
    }
    try {
      return await inbox.publish(input);
    } catch {
      return null;
    }
  };

  const queueProjectedEvent = (stateWrite, context = {}) => {
    const next = deliveryPending.catch(() => {}).then(async () => publishProjectedEvent(await stateWrite, context));
    deliveryPending = next;
    return next;
  };

  const reduce = (operation) => {
    if (!enabled) return Promise.resolve(null);
    const next = (async () => {
      await pending.catch(() => {});
      const release = await acquireSessionLock(activityDirectory, ownerSessionId);
      if (!release) return null;
      try {
        const nowMs = now();
        const stored = await readStoredState(activityDirectory, ownerSessionId);
        if (
          stored?.worker?.writer_instance_id &&
          stored.worker.writer_instance_id !== safeIdentifier(writerInstanceId)
        ) {
          const lastHeartbeat = Date.parse(String(stored.worker.last_heartbeat_at || ""));
          const stale = !Number.isFinite(lastHeartbeat) || nowMs - lastHeartbeat > DEFAULT_STALE_AFTER_MS;
          if (stored.worker.connection !== "stopped" && !stale) return null;
        }
        const state = stored || emptyState({ ownerSessionId, workerId, writerInstanceId, agentId, agentName, nowMs });
        const result = await operation(state, nowMs);
        if (result === false) return null;
        state.updated_at = new Date(nowMs).toISOString();
        await writeState(activityDirectory, ownerSessionId, state);
        return result;
      } finally {
        await release();
      }
    })();
    pending = next;
    return next;
  };

  return {
    enabled,
    activityDirectory,
    ownerSessionId,

    heartbeat({ connection = "connected" } = {}) {
      if (!CONNECTIONS.has(connection)) return Promise.resolve(null);
      const stateWrite = reduce((state, nowMs) => {
        const lastHeartbeat = Date.parse(String(state.worker.last_heartbeat_at || ""));
        const transition = state.worker.connection !== connection;
        if (!transition && Number.isFinite(lastHeartbeat) && nowMs - lastHeartbeat < HEARTBEAT_WRITE_INTERVAL_MS) {
          return false;
        }
        state.worker = {
          worker_id: safeIdentifier(workerId),
          writer_instance_id: safeIdentifier(writerInstanceId),
          agent_id: safeIdentifier(agentId),
          agent_name: safeText(agentName, 80),
          connection,
          last_heartbeat_at: new Date(nowMs).toISOString(),
        };
        return transition ? appendEvent(state, { kind: `worker.${connection}` }, nowMs) : null;
      });
      return queueProjectedEvent(stateWrite);
    },

    publish({ diagnostic, safeTitle = "", flowUrl = "" } = {}) {
      const record = normalizeWorkerDiagnostic(diagnostic);
      if (!record || record.worker_id !== safeIdentifier(workerId)) return Promise.resolve(null);
      const stateWrite = reduce((state, nowMs) => {
        const canonicalPhase = progressPhaseForDiagnostic(record.phase);
        const kind = eventKindForDiagnostic(record, canonicalPhase);
        if (!kind) return false;
        const taskId = safeIdentifier(record.task_id);
        const runId = safeIdentifier(record.run_id);
        const existingIndex = state.active_tasks.findIndex((task) => task.task_id === taskId);
        const existing = existingIndex >= 0 ? state.active_tasks[existingIndex] : null;
        const phase = canonicalPhase || existing?.phase || "delivering_result";
        const summary = summaryForDiagnostic(record, phase);
        const recordAt = Date.parse(String(record.occurred_at || ""));
        const existingAt = Date.parse(String(existing?.updated_at || ""));
        const advancesProjection =
          !existing || !Number.isFinite(existingAt) || !Number.isFinite(recordAt) || recordAt >= existingAt;
        const task = {
          task_id: taskId,
          run_id: runId,
          safe_title: safeText(safeTitle, 120),
          phase,
          safe_summary: summary,
          started_at: existing?.started_at || record.occurred_at || new Date(nowMs).toISOString(),
          updated_at: record.occurred_at || new Date(nowMs).toISOString(),
          ...(safeUrl(flowUrl) ? { flow_url: safeUrl(flowUrl) } : {}),
        };
        if (kind === "task.completed" || kind === "task.failed") {
          if (advancesProjection) {
            if (existingIndex >= 0) state.active_tasks.splice(existingIndex, 1);
            state.last_terminal_task = task;
          }
        } else if (existingIndex >= 0 && advancesProjection) {
          state.active_tasks[existingIndex] = task;
        } else {
          if (!existing) state.active_tasks.push(task);
        }
        return appendEvent(
          state,
          {
            kind,
            task_id: taskId,
            run_id: runId,
            phase,
            safe_summary: summary,
            artifact_kind: safeIdentifier(record.artifact_kind, 64),
            artifact_role: safeIdentifier(record.artifact_role, 64),
            size: record.size,
            duration_ms:
              ["task.completed", "task.failed"].includes(kind) && existing?.started_at
                ? Math.max(0, Math.round(Date.parse(record.occurred_at) - Date.parse(existing.started_at)))
                : undefined,
          },
          nowMs
        );
      });
      return queueProjectedEvent(stateWrite, { safeTitle, flowUrl });
    },

    async flush() {
      await pending;
      await deliveryPending;
    },
  };
}

export async function readSessionActivity({
  sessionId,
  activityDirectory = defaultActivityDirectory(),
  now = Date.now,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
} = {}) {
  if (!validSessionId(sessionId)) return null;
  const state = await readStoredState(activityDirectory, sessionId);
  if (!state) return null;
  const result = structuredClone(state);
  const heartbeatAt = Date.parse(String(result.worker.last_heartbeat_at || ""));
  if (
    result.worker.connection === "connected" &&
    (!Number.isFinite(heartbeatAt) || now() - heartbeatAt > Math.max(1, staleAfterMs))
  ) {
    result.worker.connection = "disconnected";
  }
  return result;
}

function readableEvent(value, sessionId, nowMs, retentionMs) {
  if (
    !value ||
    value.version !== STATE_VERSION ||
    value.owner_session_id !== sessionId ||
    !EVENT_KINDS.has(value.kind) ||
    typeof value.occurred_at !== "string"
  ) {
    return null;
  }
  const occurredAt = Date.parse(value.occurred_at);
  if (!Number.isFinite(occurredAt) || occurredAt > nowMs + 60_000 || nowMs - occurredAt > retentionMs) return null;
  return normalizeEvent(value, {
    ownerSessionId: sessionId,
    now: () => occurredAt,
    id: () => value.id,
  });
}

async function recoverStaleClaims(processingDirectory, eventDirectory, nowMs) {
  let entries;
  try {
    entries = await fs.readdir(processingDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const claimed = path.join(processingDirectory, entry.name);
    try {
      const stat = await fs.stat(claimed);
      if (nowMs - stat.mtimeMs <= STALE_CLAIM_MS) continue;
      const separator = entry.name.indexOf("__");
      const originalName = separator === -1 ? entry.name : entry.name.slice(separator + 2);
      await fs.rename(claimed, path.join(eventDirectory, originalName));
    } catch (error) {
      if (!["ENOENT", "EEXIST"].includes(error?.code)) throw error;
    }
  }
}

function eventTaskKey(event) {
  return event.task_id || event.run_id || `${event.worker_id}:${event.kind}`;
}

function significantEvents(events, maxEvents) {
  const latestByTask = new Map();
  for (const event of events) {
    if (SIGNIFICANT_KINDS.has(event.kind)) latestByTask.set(eventTaskKey(event), event);
  }
  return [...latestByTask.values()]
    .sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at))
    .slice(-maxEvents);
}

export async function consumeSessionActivity({
  sessionId,
  activityDirectory = defaultActivityDirectory(),
  now = Date.now,
  retentionMs = DEFAULT_RETENTION_MS,
  maxEvents = 3,
} = {}) {
  if (!validSessionId(sessionId)) return [];
  const root = sessionDirectory(activityDirectory, sessionId);
  const eventDirectory = path.join(root, "events");
  try {
    if (!(await fs.readdir(eventDirectory)).some((name) => name.endsWith(".json"))) return [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [];
  }
  const release = await acquireSessionLock(activityDirectory, sessionId).catch(() => null);
  if (!release) return [];
  try {
    const processingDirectory = path.join(root, "processing");
    const nowMs = now();
    let initialNames;
    try {
      initialNames = await fs.readdir(eventDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    if (!initialNames.some((name) => name.endsWith(".json"))) return [];
    await ensurePrivateDirectory(processingDirectory);
    await recoverStaleClaims(processingDirectory, eventDirectory, nowMs);
    const names = (await fs.readdir(eventDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, MAX_EVENT_FILES);
    const claimId = `${process.pid}-${randomUUID()}`;
    const claimed = [];
    for (const name of names) {
      const source = path.join(eventDirectory, name);
      const target = path.join(processingDirectory, `${claimId}__${name}`);
      try {
        await fs.rename(source, target);
        claimed.push(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const events = [];
    for (const filePath of claimed) {
      try {
        const body = await fs.readFile(filePath, "utf8");
        if (Buffer.byteLength(body) <= MAX_EVENT_BYTES) {
          const event = readableEvent(JSON.parse(body), sessionId, nowMs, retentionMs);
          if (event) events.push(event);
        }
      } catch {
        // Hook consumption fails open and discards malformed private events.
      } finally {
        await removeFileQuietly(filePath);
      }
    }
    return significantEvents(events, Math.max(1, maxEvents));
  } catch {
    return [];
  } finally {
    await release();
  }
}

function durationText(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return ` in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return ` in ${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

function eventSentence(event) {
  const subject = event.agent_name || "Remote agent";
  const title = event.safe_title ? ` “${event.safe_title}”` : "";
  if (event.kind === "worker.disconnected") return `${subject} lost its Flow connection.`;
  if (event.kind === "task.claimed") return `${subject} started${title}.`;
  if (event.kind === "task.attention") {
    return `${subject} needs attention for${title}${event.safe_summary ? `: ${event.safe_summary}` : "."}`;
  }
  if (event.kind === "task.completed") return `${subject} completed${title}${durationText(event.duration_ms)}.`;
  if (event.kind === "task.failed") return `${subject} failed${title}.`;
  if (event.kind === "task.requeued") return `${subject} could not finish${title}; Flow requeued it.`;
  return "";
}

export function activityContext(events) {
  const sentences = (Array.isArray(events) ? events : []).map(eventSentence).filter(Boolean);
  if (!sentences.length) return "";
  return [
    "Nuanu Flow remote-worker update for this Codex session:",
    sentences.join(" "),
    "Briefly tell the user this update before answering their current request. Do not expose internal event or session IDs.",
  ].join(" ");
}

async function newestSessionActivityMs(sessionPath, state) {
  let newest = Date.parse(String(state?.updated_at || ""));
  if (!Number.isFinite(newest)) newest = 0;
  let entries = [];
  try {
    entries = await fs.readdir(sessionPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return newest;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "activity.lock") continue;
    try {
      const stat = await fs.stat(path.join(sessionPath, entry.name));
      newest = Math.max(newest, stat.mtimeMs);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return newest;
}

async function cleanupSessionScratch(sessionPath, nowMs, retentionMs = DEFAULT_RETENTION_MS) {
  let entries = [];
  try {
    entries = await fs.readdir(sessionPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(sessionPath, entry.name);
    if (entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      try {
        const stat = await fs.stat(candidate);
        if (nowMs - stat.mtimeMs > STALE_CLAIM_MS) await removeFileQuietly(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  const eventDirectory = path.join(sessionPath, "events");
  const processingDirectory = path.join(sessionPath, "processing");
  await pruneEventFiles(eventDirectory, nowMs, retentionMs);
  await recoverStaleClaims(processingDirectory, eventDirectory, nowMs);
  for (const directory of [processingDirectory, eventDirectory]) {
    try {
      if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
  }
}

const cleanupByRoot = new Map();

async function runSessionActivityCleanup({
  activityDirectory = defaultActivityDirectory(),
  now = Date.now,
  retentionMs = DEFAULT_RETENTION_MS,
  limit = 100,
} = {}) {
  const sessionsRoot = path.join(activityDirectory, "sessions");
  let entries;
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const candidates = [];
  const abandonedGc = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".gc-") && /^\.gc-[A-Za-z0-9_-]{3,240}$/.test(entry.name)) {
      try {
        const gcPath = path.join(sessionsRoot, entry.name);
        const stat = await fs.stat(gcPath);
        abandonedGc.push({ name: entry.name, sessionPath: gcPath, mtimeMs: stat.mtimeMs });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      continue;
    }
    if (!validSessionId(entry.name)) continue;
    const sessionPath = path.join(sessionsRoot, entry.name);
    try {
      const stat = await fs.stat(sessionPath);
      candidates.push({ name: entry.name, sessionPath, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  abandonedGc.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let budget = Math.max(1, Math.min(Number(limit) || 100, 100));
  for (const candidate of abandonedGc) {
    if (budget <= 0) break;
    budget -= 1;
    if (now() - candidate.mtimeMs <= retentionMs) continue;
    await fs.rm(candidate.sessionPath, { recursive: true, force: true });
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const removed = [];
  for (const candidate of candidates.slice(0, budget)) {
    const release = await acquireSessionLock(activityDirectory, candidate.name).catch(() => null);
    if (!release) continue;
    let renamed = "";
    try {
      const state = await readStoredState(activityDirectory, candidate.name);
      await cleanupSessionScratch(candidate.sessionPath, now(), retentionMs);
      const remaining = (await fs.readdir(candidate.sessionPath)).filter((name) => name !== "activity.lock");
      if (remaining.length === 0) {
        renamed = path.join(sessionsRoot, `.gc-${candidate.name}-${randomUUID()}`);
        await fs.rename(candidate.sessionPath, renamed);
      } else {
        const newest = await newestSessionActivityMs(candidate.sessionPath, state);
        const heartbeatAt = Date.parse(String(state?.worker?.last_heartbeat_at || ""));
        const active =
          state?.worker?.connection === "connected" &&
          Number.isFinite(heartbeatAt) &&
          now() - heartbeatAt <= DEFAULT_STALE_AFTER_MS;
        if (active || now() - newest <= retentionMs) continue;
        renamed = path.join(sessionsRoot, `.gc-${candidate.name}-${randomUUID()}`);
        await fs.rename(candidate.sessionPath, renamed);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      await release();
    }
    if (renamed) {
      await fs.rm(renamed, { recursive: true, force: true });
      removed.push(candidate.name);
    }
  }
  return removed;
}

export function cleanupSessionActivity(options = {}) {
  const activityDirectory = options.activityDirectory || defaultActivityDirectory();
  const rootKey = path.resolve(activityDirectory);
  const existing = cleanupByRoot.get(rootKey);
  if (existing) return existing;
  const cleanup = Promise.resolve()
    .then(() => runSessionActivityCleanup({ ...options, activityDirectory }))
    .finally(() => {
      if (cleanupByRoot.get(rootKey) === cleanup) cleanupByRoot.delete(rootKey);
    });
  cleanupByRoot.set(rootKey, cleanup);
  return cleanup;
}

export const sessionActivityInternals = {
  EVENT_KINDS,
  MAX_RECENT_EVENTS,
  MAX_STATE_BYTES,
  acquireSessionLock,
  normalizeEvent,
  safeText,
  sessionDirectory,
  statePath,
  validSessionId,
};
