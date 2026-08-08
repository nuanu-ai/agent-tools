import { fileURLToPath } from "node:url";

import { defaultActivityDirectory, readSessionActivity } from "./session_activity.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 1_000;

const PHASE_LABELS = Object.freeze({
  claimed: "Claimed by remote worker",
  preparing_workspace: "Preparing task workspace",
  preparing_repository: "Preparing repository",
  starting_runtime: "Starting agent runtime",
  working: "Working",
  publishing_artifact: "Publishing artifact",
  waiting_for_human: "Waiting for human input",
  retrying_provider: "Retrying provider",
  delivering_result: "Delivering result to Flow",
  completed: "Completed and acknowledged by Flow",
  failed: "Failed and acknowledged by Flow",
});

function safeText(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/\/(?:Users|home|private|var|tmp)\/[^\s,;:)]+/g, "[path]")
      .replace(/nuanu_(?:join|flow)_[A-Za-z0-9_-]{16,}/gi, "[redacted]")
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gi, "[redacted]")
      .replace(/\b(authorization|api[_ -]?key|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .trim()
      .slice(0, maxLength)
  );
}

function safeIdentifier(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._:-]/g, "")
    .slice(0, 100);
}

function safeFlowUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function durationLabel(milliseconds) {
  const seconds = Math.max(0, Math.ceil(Number(milliseconds) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

function sizeLabel(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${Math.round((size / (1024 * 1024)) * 10) / 10} MiB`;
}

function phaseLabel(phase, fallback = "") {
  return PHASE_LABELS[phase] || safeText(fallback, 200) || "Working";
}

function eventLabel(event) {
  const byKind = {
    "worker.connected": "Remote agent connected",
    "worker.disconnected": "Remote agent disconnected",
    "worker.stopped": "Remote agent stopped",
    "task.claimed": "Claimed by remote worker",
    "task.started": "Running",
    "task.completed": "Completed and acknowledged by Flow",
    "task.failed": "Failed and acknowledged by Flow",
    "task.requeued": "Requeued by Flow",
  };
  if (byKind[event?.kind]) return byKind[event.kind];
  if (event?.kind === "task.progress" && event?.phase === "working") {
    return safeText(event.safe_summary, 200) || "Working";
  }
  return phaseLabel(event?.phase, event?.safe_summary);
}

function clockLabel(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString().slice(11, 19) : "--:--:--";
}

function eventSequence(event) {
  return Number.isSafeInteger(event?.sequence) && event.sequence >= 0 ? event.sequence : -1;
}

function latestSequence(events) {
  return events.reduce((latest, event) => Math.max(latest, eventSequence(event)), -1);
}

function activeTaskForId(state, taskId) {
  return state?.active_tasks?.find((task) => task?.task_id === taskId) || null;
}

export function renderWorkerEvent(event) {
  const parts = [`${clockLabel(event?.occurred_at)} ${eventLabel(event)}`];
  const artifactKind = safeIdentifier(event?.artifact_kind);
  const artifactRole = safeIdentifier(event?.artifact_role);
  if (artifactKind || artifactRole) parts.push([artifactKind, artifactRole].filter(Boolean).join("/"));
  const size = sizeLabel(event?.size);
  if (size) parts.push(size);
  return parts.join(" · ");
}

export function renderWorkerState(state, { now = Date.now } = {}) {
  const worker = state?.worker || {};
  const agent = safeText(worker.agent_name, 80) || "Remote agent";
  const connection = ["connected", "disconnected", "stopped"].includes(worker.connection)
    ? worker.connection
    : "unavailable";
  const lines = [`Nuanu Flow · ${agent} · ${connection}`];
  const tasks = Array.isArray(state?.active_tasks) ? state.active_tasks : [];
  if (!tasks.length) {
    lines.push("Idle");
    if (state?.last_terminal_task?.safe_title) {
      lines.push(
        `Last: ${safeText(state.last_terminal_task.safe_title, 120)} · ${phaseLabel(
          state.last_terminal_task.phase,
          state.last_terminal_task.safe_summary
        )}`
      );
    }
    return lines.join("\n");
  }

  for (const task of tasks) {
    const startedAt = Date.parse(String(task?.started_at || ""));
    const elapsed = Number.isFinite(startedAt) ? durationLabel(Math.max(0, now() - startedAt)) : "unknown duration";
    const title = safeText(task?.safe_title, 120) || "Remote task";
    lines.push(`${title} · ${phaseLabel(task?.phase, task?.safe_summary)} · ${elapsed}`);
    const taskId = safeIdentifier(task?.task_id);
    const runId = safeIdentifier(task?.run_id);
    if (taskId) lines.push(`Task ${taskId}`);
    if (runId) lines.push(`Run ${runId}`);
    const flowUrl = safeFlowUrl(task?.flow_url);
    if (flowUrl) lines.push(`Open Flow: ${flowUrl}`);
  }
  return lines.join("\n");
}

function renderEventBatch(events, { cursor, write, shouldRender = () => true }) {
  const ordered = [...events]
    .filter((event) => eventSequence(event) > cursor)
    .sort((left, right) => eventSequence(left) - eventSequence(right));
  if (!ordered.length) return cursor;
  if (cursor >= 0 && eventSequence(ordered[0]) > cursor + 1) {
    write(`${eventSequence(ordered[0]) - cursor - 1} earlier updates omitted`);
  }
  for (const event of ordered) {
    if (shouldRender(event)) write(renderWorkerEvent(event));
  }
  return Math.max(cursor, latestSequence(ordered));
}

export async function observeWorker({
  mode,
  sessionId,
  activityDirectory = defaultActivityDirectory(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  write = console.log,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  signal,
} = {}) {
  if (!sessionId) {
    write("No Codex conversation is bound to the Nuanu Flow worker.");
    return 2;
  }
  if (!new Set(["peek", "babysit"]).has(mode)) {
    write("Usage: session_observer.mjs <peek|babysit> [--timeout SECONDS]");
    return 2;
  }
  let state = await readSessionActivity({ sessionId, activityDirectory, now });
  if (!state) {
    write("No session activity is available for this Codex conversation.");
    return 2;
  }
  if (mode === "peek") {
    write(renderWorkerState(state, { now }));
    return 0;
  }

  const worker = state.worker || {};
  write(`Nuanu Flow · ${safeText(worker.agent_name, 80) || "Remote agent"} · ${worker.connection || "unavailable"}`);
  const capturedTaskId = safeIdentifier(state.active_tasks?.[0]?.task_id);
  if (!capturedTaskId) {
    write("Idle");
    return 0;
  }
  let cursor = renderEventBatch(state.recent_events || [], {
    cursor: 0,
    write,
    shouldRender: (event) => event.task_id === capturedTaskId,
  });

  const startedAt = now();
  const deadlineMs = startedAt + boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, { max: MAX_TIMEOUT_MS });
  const intervalMs = boundedInteger(pollMs, DEFAULT_POLL_MS, { min: 50, max: 10_000 });
  while (now() < deadlineMs) {
    if (signal?.aborted) {
      write("Stopped watching. The remote task is still running.");
      return 0;
    }
    await sleep(intervalMs);
    state = await readSessionActivity({ sessionId, activityDirectory, now });
    if (!state) {
      write("Session activity became unavailable.");
      return 2;
    }
    cursor = renderEventBatch(state.recent_events || [], {
      cursor,
      write,
      shouldRender: (event) => event.task_id === capturedTaskId || String(event.kind || "").startsWith("worker."),
    });
    if (!activeTaskForId(state, capturedTaskId)) {
      const terminalMatches =
        state.last_terminal_task?.task_id === capturedTaskId ||
        (state.recent_events || []).some(
          (event) => event.task_id === capturedTaskId && ["task.completed", "task.failed"].includes(event.kind)
        );
      if (!terminalMatches) write("The observed task is no longer active.");
      return 0;
    }
  }
  write(`Stopped watching after ${durationLabel(deadlineMs - startedAt)}. The remote task is still running.`);
  return 3;
}

function parseCli(argv) {
  const mode = argv[0];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--timeout" && argv[index + 1]) {
      timeoutMs = boundedInteger(Number(argv[index + 1]) * 1000, DEFAULT_TIMEOUT_MS, { max: MAX_TIMEOUT_MS });
      index += 1;
    }
  }
  return { mode, timeoutMs };
}

async function main() {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const { mode, timeoutMs } = parseCli(process.argv.slice(2));
  process.exitCode = await observeWorker({
    mode,
    timeoutMs,
    signal: controller.signal,
    sessionId: process.env.NUANU_OWNER_SESSION_ID || process.env.CODEX_THREAD_ID || "",
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

export const sessionObserverInternals = {
  MAX_TIMEOUT_MS,
  PHASE_LABELS,
  parseCli,
};
