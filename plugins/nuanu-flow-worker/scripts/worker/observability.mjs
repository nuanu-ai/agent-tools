import { normalizeWorkerDiagnostic, sanitizeDiagnosticMessage, WORKER_DIAGNOSTIC_VERSION } from "./diagnostic_log.mjs";
import { safeTaskEvent } from "./diagnostics.mjs";

export const WORKER_PROGRESS_VERSION = "nuanu.worker-progress.v1";
export const WORKER_FAILURE_DETAILS_VERSION = "nuanu.worker-failure-details.v1";

const PROGRESS_BY_DIAGNOSTIC = new Map([
  ["task_claimed", "claimed"],
  ["task_workspace_ready", "preparing_workspace"],
  ["repository_preparing", "preparing_repository"],
  ["repository_ready", "preparing_repository"],
  ["runtime_starting", "starting_runtime"],
  ["runtime_working", "working"],
  ["artifact_tool_started", "publishing_artifact"],
  ["artifact_upload_started", "publishing_artifact"],
  ["waiting_for_human", "waiting_for_human"],
  ["provider_retry", "retrying_provider"],
  ["terminal_delivery_started", "delivering_result"],
  ["task_completed", "completed"],
  ["task_failed", "failed"],
]);

export function progressPhaseForDiagnostic(phase) {
  return PROGRESS_BY_DIAGNOSTIC.get(String(phase || "")) || null;
}

export function diagnosticFromTaskEvent(value) {
  const event = safeTaskEvent(value);
  if (!event) return null;
  let category = "worker";
  if (event.phase.startsWith("artifact_")) category = "artifact";
  else if (event.phase.startsWith("terminal_delivery_")) category = "delivery";
  else if (event.phase.startsWith("repository_")) category = "repository";
  else if (event.phase.startsWith("provider_")) category = "provider";
  else if (event.phase.startsWith("lease_")) category = "lease";
  else if (event.phase === "waiting_for_human") category = "human_input";
  else if (event.phase.includes("workspace")) category = "workspace";
  else if (event.phase.startsWith("runtime_")) category = "runtime";
  const level = event.phase.endsWith("failed")
    ? "error"
    : event.phase.includes("retrying") || event.phase.endsWith("rejected")
      ? "warning"
      : "info";
  return {
    category,
    phase: event.phase,
    level,
    ...(event.kind ? { artifact_kind: event.kind } : {}),
    ...(event.role ? { artifact_role: event.role } : {}),
    ...(event.size !== undefined ? { size: event.size } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.status !== undefined ? { status_code: event.status } : {}),
    ...(event.code ? { error_code: event.code } : {}),
  };
}

export function diagnosticFromActivityEvent(value) {
  if (!value || !["task.started", "task.progress", "task.attention"].includes(value.kind)) return null;
  const safeMessage = sanitizeDiagnosticMessage(value.safe_summary);
  if (value.kind === "task.attention") {
    return {
      category: "human_input",
      phase: "waiting_for_human",
      level: "warning",
      ...(safeMessage ? { safe_message: safeMessage } : {}),
    };
  }
  return {
    category: "runtime",
    phase: value.kind === "task.started" ? "runtime_starting" : "runtime_working",
    level: "info",
    ...(safeMessage ? { safe_message: safeMessage } : {}),
  };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createTaskObservability({
  task,
  workerId,
  adapter,
  client,
  leaseToken,
  logStore,
  now = Date.now,
  maxAttempts = 5,
  onWarning = () => {},
  onDiagnostic = null,
}) {
  let fenced = false;
  let progress = null;
  let latest = null;
  let localLogsAvailable = false;
  let publishedProgressSignature = "";
  const attempt = positiveInteger(task?.attempt, 1);
  const boundedMaxAttempts = positiveInteger(maxAttempts, 5);

  const publishProgress = async ({ force = true } = {}) => {
    if (fenced || !progress) return false;
    const signature = JSON.stringify(progress);
    if (!force && signature === publishedProgressSignature) return false;
    publishedProgressSignature = signature;
    try {
      await client.checkpointTask(task.task_id, {
        workerId,
        leaseToken,
        checkpoint: { progress },
      });
      return true;
    } catch (error) {
      if (publishedProgressSignature === signature) publishedProgressSignature = "";
      if (error?.status === 409) fenced = true;
      else onWarning(error);
      return false;
    }
  };

  return {
    async record(input) {
      const record = normalizeWorkerDiagnostic({
        schema_version: WORKER_DIAGNOSTIC_VERSION,
        occurred_at: new Date(now()).toISOString(),
        task_id: task.task_id,
        run_id: task.run_id,
        worker_id: workerId,
        adapter,
        ...input,
      });
      if (!record) return null;
      latest = record;
      try {
        localLogsAvailable = Boolean(await logStore.append(record)) || localLogsAvailable;
      } catch (error) {
        onWarning(error);
      }
      if (typeof onDiagnostic === "function") {
        try {
          Promise.resolve(onDiagnostic(record)).catch(onWarning);
        } catch (error) {
          onWarning(error);
        }
      }

      const phase = progressPhaseForDiagnostic(record.phase);
      if (phase) {
        progress = {
          schema_version: WORKER_PROGRESS_VERSION,
          phase,
          attempt,
          max_attempts: boundedMaxAttempts,
          adapter,
          ...(record.session_id ? { session_id: record.session_id } : {}),
          ...(record.turn_id ? { turn_id: record.turn_id } : {}),
        };
        await publishProgress({ force: false });
      }
      return record;
    },

    async refresh() {
      return publishProgress();
    },

    currentProgress() {
      return progress ? { ...progress } : null;
    },

    isFenced() {
      return fenced;
    },

    failureDetails(overrides = {}) {
      const source = { ...(latest || {}), ...overrides };
      const details = {
        schema_version: WORKER_FAILURE_DETAILS_VERSION,
        worker_id: workerId,
        adapter,
      };
      for (const key of ["provider", "model", "session_id", "turn_id", "error_code"]) {
        if (typeof source[key] === "string" && source[key]) details[key] = source[key].slice(0, 255);
      }
      if (typeof source.phase === "string" && source.phase) details.phase = source.phase;
      details.attempt = positiveInteger(source.attempt, attempt);
      details.max_attempts = positiveInteger(source.max_attempts, boundedMaxAttempts);
      if (Number.isSafeInteger(source.status_code) && source.status_code >= 0 && source.status_code <= 599) {
        details.status_code = source.status_code;
      }
      if (typeof source.retryable === "boolean") details.retryable = source.retryable;
      const safeMessage = sanitizeDiagnosticMessage(source.safe_message);
      if (safeMessage) details.safe_message = safeMessage;
      details.local_logs_available = localLogsAvailable;
      return details;
    },
  };
}
