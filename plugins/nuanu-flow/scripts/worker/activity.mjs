import {
  createActivityStore,
} from "../activity/remote-worker-activity.mjs";

function compact(value, maxLength) {
  return String(value || "")
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

export function safeTaskTitle(task) {
  return (
    compact(task?.step_name, 120) ||
    compact(task?.step_id, 120) ||
    `Task ${compact(task?.task_id, 8) || "unknown"}`
  );
}

function quotedTitle(event) {
  return event.safe_title ? ` “${event.safe_title}”` : "";
}

function durationText(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return ` in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return ` in ${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

export function renderActivity(event) {
  switch (event.kind) {
    case "worker.connected":
      return "● Remote agent connected";
    case "worker.disconnected":
      return "○ Remote agent disconnected; retrying";
    case "worker.stopped":
      return "■ Remote agent stopped";
    case "task.claimed":
      return `▶ Claimed${quotedTitle(event)}`;
    case "task.started":
      return `● Running${quotedTitle(event)}`;
    case "task.progress":
      return `├ ${event.safe_summary || "Working"}`;
    case "task.attention":
      return `! Needs attention${quotedTitle(event)}${
        event.safe_summary ? ` — ${event.safe_summary}` : ""
      }`;
    case "task.completed":
      return `✓ Completed${quotedTitle(event)}${durationText(
        event.duration_ms,
      )}`;
    case "task.failed":
      return `✕ Failed${quotedTitle(event)}`;
    case "task.requeued":
      return `↻ Requeued${quotedTitle(event)}`;
    default:
      return "";
  }
}

export function createWorkerActivity({
  config,
  log,
  now = Date.now,
} = {}) {
  const store = createActivityStore({
    activityDirectory: config?.directory,
    ownerSessionId: config?.ownerSessionId,
    now,
  });
  let pending = Promise.resolve();
  const lastProgressByTask = new Map();
  const lastAttentionByTask = new Map();

  function emit(input) {
    const event = {
      worker_id: config?.workerId,
      agent_id: config?.agentId,
      agent_name: config?.agentName,
      ...input,
    };
    if (event.kind === "task.progress") {
      const key = event.task_id || event.run_id || "worker";
      const progress = compact(event.safe_summary, 200);
      if (lastProgressByTask.get(key) === progress) return pending;
      lastProgressByTask.set(key, progress);
      event.safe_summary = progress;
    }
    if (event.kind === "task.attention") {
      const key = event.task_id || event.run_id || "worker";
      const attention = compact(event.safe_summary, 200);
      if (lastAttentionByTask.get(key) === attention) return pending;
      lastAttentionByTask.set(key, attention);
      event.safe_summary = attention;
    }
    if (
      event.kind === "task.completed" ||
      event.kind === "task.failed" ||
      event.kind === "task.requeued"
    ) {
      lastProgressByTask.delete(event.task_id || event.run_id || "worker");
      lastAttentionByTask.delete(event.task_id || event.run_id || "worker");
    }
    const rendered = renderActivity(event);
    if (rendered) log(rendered);
    pending = pending
      .then(() => store.publish(event))
      .catch(() => {
        log("activity inbox unavailable; live worker output continues");
      });
    return pending;
  }

  return {
    attached: store.enabled,
    emit,
    async flush() {
      await pending;
    },
  };
}
