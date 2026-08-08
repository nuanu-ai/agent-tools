const ERROR_CODES = new Set([
  "invalid_input",
  "capability_unavailable",
  "authentication_required",
  "permission_denied",
  "timeout",
  "cancelled",
  "lease_lost",
  "protocol_error",
  "invalid_output",
  "artifact_verification_failed",
  "stale_repository",
  "provider_error",
  "internal_error",
]);

export const retryableStatus = (status) =>
  status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);

export function buildFailureCompletion(
  task,
  { code = "internal_error", message = "Agent Task failed", retryable = false }
) {
  return {
    schema_version: "nuanu.agent-task.completion.v1",
    task_id: String(task.task_id),
    attempt: Math.max(1, Number(task.attempt || task.lease_generation || 1)),
    outcome: "failure",
    error: {
      code: ERROR_CODES.has(String(code)) ? String(code) : "internal_error",
      message: String(message || "Agent Task failed").slice(0, 4000),
      retryable: Boolean(retryable),
    },
  };
}

export function createCanonicalCompletionSender({
  client,
  task,
  workerId,
  leaseToken,
  completion,
  output = "",
  options,
  repositoryResult,
  onContractRejected = () => {},
}) {
  let current = completion;
  let converted = false;
  return async () => {
    try {
      return await client.complete(task.task_id, {
        output,
        options,
        completion: current,
        workerId,
        leaseToken,
        ...(current?.outcome === "success" && repositoryResult ? { repositoryResult } : {}),
      });
    } catch (error) {
      if (error?.status !== 400 || current?.outcome !== "success" || converted) throw error;
      converted = true;
      const rejection = onContractRejected(error) || {};
      const rejectionPath = String(rejection.path || "$");
      const rejectionMessage = String(rejection.message || "The server rejected the result contract.");
      current = buildFailureCompletion(task, {
        code: "invalid_output",
        message: `${rejectionPath}: ${rejectionMessage}`,
        retryable: false,
      });
      return client.complete(task.task_id, {
        output: "",
        completion: current,
        workerId,
        leaseToken,
      });
    }
  };
}

function acknowledged(result) {
  return Boolean(result && (result.status === "ok" || result.already === true));
}

function statusOf(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 0 ? status : 0;
}

export async function deliverTerminal({
  send,
  renew = null,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineAt,
  baseDelayMs = 500,
  maxDelayMs = 5_000,
  onRetry = () => {},
}) {
  if (typeof send !== "function") throw new Error("Terminal delivery requires send()");
  const parsedDeadline = Date.parse(String(deadlineAt || ""));
  const deadline = Number.isFinite(parsedDeadline) ? parsedDeadline : now() + 30_000;
  let attempts = 0;

  while (now() <= deadline) {
    attempts += 1;
    try {
      const result = await send();
      if (acknowledged(result)) return { state: "acknowledged", attempts, status: 200 };
      return { state: "unacknowledged", attempts, status: 0, reason: "missing_acknowledgement" };
    } catch (error) {
      const status = statusOf(error);
      if (status === 409) return { state: "fenced", attempts, status };
      const retryable = error?.retryable === true || retryableStatus(status);
      if (!retryable) return { state: "unacknowledged", attempts, status, reason: "non_retryable" };
      if (now() >= deadline) {
        return { state: "unacknowledged", attempts, status, reason: "deadline_exhausted" };
      }

      if (typeof renew === "function") {
        try {
          await renew();
        } catch (renewError) {
          if (statusOf(renewError) === 409) return { state: "fenced", attempts, status: 409 };
        }
      }
      const delayMs = Math.min(
        Math.max(1, maxDelayMs),
        Math.max(1, baseDelayMs) * 2 ** Math.max(0, attempts - 1),
        Math.max(0, deadline - now())
      );
      onRetry({ attempt: attempts + 1, status });
      if (delayMs <= 0) {
        return { state: "unacknowledged", attempts, status, reason: "deadline_exhausted" };
      }
      await sleep(delayMs);
    }
  }

  return { state: "unacknowledged", attempts, status: 0, reason: "deadline_exhausted" };
}
