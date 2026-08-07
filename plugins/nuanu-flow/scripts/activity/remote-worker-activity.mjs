import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EVENT_VERSION = 1;
const MAX_EVENT_FILES = 200;
const MAX_EVENT_BYTES = 4096;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_CLAIM_MS = 5 * 60 * 1000;

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
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function redactedText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/nuanu_(?:join|flow)_[A-Za-z0-9_-]{16,}/gi, "[redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gi, "[redacted]")
    .replace(
      /\b(authorization|api[_ -]?key|token|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .trim()
    .slice(0, maxLength);
}

function safeIdentifier(value) {
  return redactedText(String(value || ""), 100).replace(
    /[^A-Za-z0-9._:-]/g,
    "",
  );
}

function safeUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopback))
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function severityForKind(kind) {
  if (kind === "task.attention") return "attention";
  if (
    kind === "task.failed" ||
    kind === "task.requeued" ||
    kind === "worker.disconnected"
  ) {
    return "error";
  }
  return "info";
}

function normalizeEvent(
  input,
  { ownerSessionId, now = Date.now, id = randomUUID } = {},
) {
  const kind = EVENT_KINDS.has(input?.kind) ? input.kind : "";
  if (!validSessionId(ownerSessionId) || !kind) return null;
  const occurredAt = new Date(now()).toISOString();
  const durationMs = Number(input.duration_ms);
  return {
    version: EVENT_VERSION,
    id: safeIdentifier(input.id || id()),
    owner_session_id: ownerSessionId,
    worker_id: safeIdentifier(input.worker_id),
    agent_id: safeIdentifier(input.agent_id),
    agent_name: redactedText(input.agent_name, 80),
    task_id: safeIdentifier(input.task_id),
    run_id: safeIdentifier(input.run_id),
    kind,
    severity: severityForKind(kind),
    occurred_at: occurredAt,
    safe_title: redactedText(input.safe_title, 120),
    safe_summary: redactedText(input.safe_summary, 200),
    ...(Number.isFinite(durationMs) && durationMs >= 0
      ? { duration_ms: Math.round(durationMs) }
      : {}),
    ...(safeUrl(input.flow_url) ? { flow_url: safeUrl(input.flow_url) } : {}),
  };
}

function sessionDirectory(activityDirectory, sessionId) {
  if (!validSessionId(sessionId)) return "";
  return path.join(activityDirectory, "sessions", sessionId);
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function removeQuietly(filePath) {
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
    let expired = false;
    try {
      const stat = await fs.stat(filePath);
      expired = nowMs - stat.mtimeMs > retentionMs;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (index < overflow || expired) await removeQuietly(filePath);
  }
}

export function defaultActivityDirectory(env = process.env) {
  return (
    env.NUANU_ACTIVITY_DATA_DIR ||
    path.join(os.homedir(), ".config", "nuanu-flow", "activity")
  );
}

export function createActivityStore({
  activityDirectory = defaultActivityDirectory(),
  ownerSessionId,
  now = Date.now,
  id = randomUUID,
  retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
  const enabled = validSessionId(ownerSessionId);
  const root = enabled
    ? sessionDirectory(activityDirectory, ownerSessionId)
    : "";
  const eventDirectory = root ? path.join(root, "events") : "";
  let sequence = 0;

  return {
    enabled,
    activityDirectory,
    ownerSessionId,

    async publish(input) {
      const nowMs = now();
      const event = normalizeEvent(input, {
        ownerSessionId,
        now: () => nowMs,
        id,
      });
      if (!event) return null;
      await ensurePrivateDirectory(eventDirectory);
      const timestamp = String(nowMs).padStart(13, "0");
      const order = String(sequence++).padStart(6, "0");
      const filename = `${timestamp}-${order}-${event.id}.json`;
      const targetPath = path.join(eventDirectory, filename);
      const temporaryPath = path.join(
        eventDirectory,
        `.${filename}.${process.pid}.tmp`,
      );
      const body = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(body) > MAX_EVENT_BYTES) {
        throw new Error("Remote-worker activity event exceeds its size limit");
      }
      await fs.writeFile(temporaryPath, body, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, targetPath);
      await fs.chmod(targetPath, 0o600);
      await pruneEventFiles(eventDirectory, nowMs, retentionMs);
      return event;
    },
  };
}

function readableEvent(value, sessionId, nowMs, retentionMs) {
  if (
    !value ||
    value.version !== EVENT_VERSION ||
    value.owner_session_id !== sessionId ||
    !EVENT_KINDS.has(value.kind) ||
    typeof value.occurred_at !== "string"
  ) {
    return null;
  }
  const occurredAt = Date.parse(value.occurred_at);
  if (
    !Number.isFinite(occurredAt) ||
    occurredAt > nowMs + 60_000 ||
    nowMs - occurredAt > retentionMs
  ) {
    return null;
  }
  return {
    ...value,
    id: safeIdentifier(value.id),
    worker_id: safeIdentifier(value.worker_id),
    agent_id: safeIdentifier(value.agent_id),
    agent_name: redactedText(value.agent_name, 80),
    task_id: safeIdentifier(value.task_id),
    run_id: safeIdentifier(value.run_id),
    safe_title: redactedText(value.safe_title, 120),
    safe_summary: redactedText(value.safe_summary, 200),
    flow_url: safeUrl(value.flow_url),
  };
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
    const claimedPath = path.join(processingDirectory, entry.name);
    try {
      const stat = await fs.stat(claimedPath);
      if (nowMs - stat.mtimeMs <= STALE_CLAIM_MS) continue;
      const separator = entry.name.indexOf("__");
      const originalName =
        separator === -1 ? entry.name : entry.name.slice(separator + 2);
      await fs.rename(claimedPath, path.join(eventDirectory, originalName));
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
    if (!SIGNIFICANT_KINDS.has(event.kind)) continue;
    latestByTask.set(eventTaskKey(event), event);
  }
  return [...latestByTask.values()]
    .sort(
      (left, right) =>
        Date.parse(left.occurred_at) - Date.parse(right.occurred_at),
    )
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
  const processingDirectory = path.join(root, "processing");
  const nowMs = now();
  try {
    let initialNames;
    try {
      initialNames = await fs.readdir(eventDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    if (!initialNames.some((name) => name.endsWith(".json"))) return [];
    await ensurePrivateDirectory(processingDirectory);
    await recoverStaleClaims(
      processingDirectory,
      eventDirectory,
      nowMs,
    );
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
          const event = readableEvent(
            JSON.parse(body),
            sessionId,
            nowMs,
            retentionMs,
          );
          if (event) events.push(event);
        }
      } catch {
        // Malformed and unreadable events are discarded. Hooks must fail open.
      } finally {
        await removeQuietly(filePath);
      }
    }
    return significantEvents(events, Math.max(1, maxEvents));
  } catch {
    return [];
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

function subject(event) {
  return event.agent_name || "Remote agent";
}

function title(event) {
  return event.safe_title ? ` “${event.safe_title}”` : "";
}

function eventSentence(event) {
  switch (event.kind) {
    case "worker.disconnected":
      return `${subject(event)} lost its Flow connection.`;
    case "task.claimed":
      return `${subject(event)} started${title(event)}.`;
    case "task.attention":
      return `${subject(event)} needs attention for${title(event)}${
        event.safe_summary ? `: ${event.safe_summary}` : "."
      }`;
    case "task.completed":
      return `${subject(event)} completed${title(event)}${durationText(
        event.duration_ms,
      )}.`;
    case "task.failed":
      return `${subject(event)} failed${title(event)}.`;
    case "task.requeued":
      return `${subject(event)} could not finish${title(
        event,
      )}; Flow requeued it.`;
    default:
      return "";
  }
}

export function activityContext(events) {
  const sentences = events.map(eventSentence).filter(Boolean);
  if (!sentences.length) return "";
  return [
    "Nuanu Flow remote-worker update for this Codex session:",
    sentences.join(" "),
    "Briefly tell the user this update before answering their current request. Do not expose internal event or session IDs.",
  ].join(" ");
}

export const activityInternals = {
  normalizeEvent,
  redactedText,
  sessionDirectory,
};

