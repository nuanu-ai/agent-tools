const CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidateTasks = count(value.candidate_tasks);
  const eligibleTasks = count(value.eligible_tasks);
  const claimedTasks = count(value.claimed_tasks);
  const capabilityMismatch = count(value.blocked?.capability_mismatch);
  const repositoryLease = count(value.blocked?.repository_lease);
  if ([candidateTasks, eligibleTasks, claimedTasks, capabilityMismatch, repositoryLease].includes(null)) {
    return null;
  }
  const missingCapabilities = [
    ...new Set(
      (Array.isArray(value.missing_capabilities) ? value.missing_capabilities : []).filter(
        (item) => typeof item === "string" && CAPABILITY.test(item)
      )
    ),
  ].sort();
  return {
    candidateTasks,
    eligibleTasks,
    claimedTasks,
    capabilityMismatch,
    repositoryLease,
    missingCapabilities,
  };
}

export function formatEligibilityDiagnostics(value) {
  const item = normalize(value);
  if (!item) return null;
  const blocked = [];
  if (item.capabilityMismatch) blocked.push(`capability_mismatch:${item.capabilityMismatch}`);
  if (item.repositoryLease) blocked.push(`repository_lease:${item.repositoryLease}`);
  return [
    `idle: candidates=${item.candidateTasks}`,
    `eligible=${item.eligibleTasks}`,
    `claimed=${item.claimedTasks}`,
    blocked.length ? `blocked=${blocked.join(",")}` : "blocked=none",
    item.missingCapabilities.length ? `missing=${item.missingCapabilities.join(",")}` : "missing=none",
  ].join(" ");
}

export function createEligibilityDiagnosticReporter({ emit, now = Date.now, reminderMs = 60_000 }) {
  let signature = "";
  let emittedAt = 0;
  return {
    observe(value) {
      const message = formatEligibilityDiagnostics(value);
      if (!message) return false;
      const currentTime = now();
      const blocked = !message.includes("blocked=none");
      if (message === signature && (!blocked || currentTime - emittedAt < reminderMs)) return false;
      signature = message;
      emittedAt = currentTime;
      emit(message);
      return true;
    },
  };
}

const TASK_PHASES = new Set([
  "task_workspace_ready",
  "artifact_tool_started",
  "artifact_tool_completed",
  "artifact_tool_failed",
  "artifact_tool_rejected",
  "artifact_upload_started",
  "artifact_upload_verified",
  "terminal_delivery_retrying",
  "terminal_delivery_acknowledged",
  "terminal_delivery_fenced",
  "terminal_delivery_unacknowledged",
]);

const SAFE_CATEGORY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACTIVITY_VERSION = "nuanu.agent-activity.v1";

function activityState(value, fallback = "updated") {
  return ["started", "updated", "completed", "failed"].includes(value) ? value : fallback;
}

/**
 * Project adapter-specific activity into the small, safe Process activity
 * contract. Raw protocol messages, commands, arguments, results, and paths are
 * intentionally not accepted here.
 */
export function processActivityEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema_version === ACTIVITY_VERSION) return value;

  const summary = typeof value.safe_summary === "string" ? value.safe_summary.trim().slice(0, 320) : "";
  if (!summary) return null;

  if (value.kind === "task.started") {
    return {
      schema_version: ACTIVITY_VERSION,
      kind: "state",
      summary,
      data: { state: "running", phase: "starting" },
    };
  }
  if (value.kind === "task.attention") {
    return {
      schema_version: ACTIVITY_VERSION,
      kind: "interaction",
      summary,
      ...(value.activity_id ? { activity_id: String(value.activity_id).slice(0, 180) } : {}),
      data: { state: "waiting", interaction_kind: "agent_input", phase: "waiting" },
    };
  }
  if (value.kind !== "task.progress") return null;

  const category = [
    "runtime",
    "plan",
    "tool",
    "file_change",
    "research",
    "artifact",
    "provider",
    "validation",
    "delivery",
  ].includes(value.category)
    ? value.category
    : "tool";
  return {
    schema_version: ACTIVITY_VERSION,
    kind: "activity",
    summary,
    ...(value.activity_id ? { activity_id: String(value.activity_id).slice(0, 180) } : {}),
    data: {
      category,
      state: activityState(
        value.state,
        /(?:finished|completed|updated|generated)$/i.test(summary) ? "completed" : "started"
      ),
      ...(typeof value.tool_kind === "string" && SAFE_CATEGORY.test(value.tool_kind)
        ? { tool_kind: value.tool_kind }
        : {}),
    },
  };
}

export function safeTaskEvent(value) {
  if (!value || typeof value !== "object" || !TASK_PHASES.has(value.phase)) return null;
  const result = { phase: value.phase };
  if (Number.isSafeInteger(value.size) && value.size >= 0) result.size = value.size;
  if (typeof value.kind === "string" && SAFE_CATEGORY.test(value.kind)) result.kind = value.kind;
  if (typeof value.role === "string" && SAFE_CATEGORY.test(value.role)) result.role = value.role;
  if (Number.isSafeInteger(value.attempt) && value.attempt > 0) result.attempt = value.attempt;
  if (Number.isSafeInteger(value.status) && value.status >= 0 && value.status <= 599) result.status = value.status;
  if (typeof value.code === "string" && SAFE_CATEGORY.test(value.code)) result.code = value.code;
  return result;
}

export function formatTaskDiagnostic(value) {
  const event = safeTaskEvent(value);
  if (!event) return null;
  const phase = event.phase.replace(/_([^_]+)$/, "=$1");
  return [
    phase,
    ...Object.entries(event)
      .filter(([key]) => key !== "phase")
      .map(([key, item]) => `${key}=${item}`),
  ].join(" ");
}
