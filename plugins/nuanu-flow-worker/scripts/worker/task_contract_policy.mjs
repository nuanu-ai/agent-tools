/** Task output capabilities and terminal contract error projection. */

export function taskNeedsFilePublisher(task) {
  return (
    Boolean(task?.runtime_binding?.source_work_item_id) ||
    Object.values(task?.request?.output_definition?.artifacts || {}).some(
      (artifact) => !["git.commit", "git.branch", "git.pull_request", "external.link"].includes(String(artifact?.kind))
    )
  );
}

export function taskMayWriteRepository(task) {
  return Object.values(task?.request?.output_definition?.artifacts || {}).some((artifact) =>
    ["git.commit", "git.branch"].includes(String(artifact?.kind))
  );
}

export function terminalDeadline(task) {
  const now = Date.now();
  const candidates = [task?.runtime_binding?.task_deadline_at, task?.task_credential_expires_at]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value) && value > now + 1000);
  return new Date(Math.min(now + 60_000, ...(candidates.length ? candidates : [now + 30_000]))).toISOString();
}

export function failureCode(error, fallback = "internal_error") {
  if (error?.code && /^[a-z][a-z0-9_]{1,63}$/.test(String(error.code))) return String(error.code);
  const message = String(error?.message || error || "");
  if (/invalid nuanu\.agent-task|artifacts must be an array/i.test(message)) return "invalid_output";
  if (error?.status === 400) return "invalid_input";
  if (error?.status === 401) return "authentication_required";
  if (error?.status === 403) return "permission_denied";
  if (error?.status === 408) return "timeout";
  return fallback;
}

export function firstContractIssue(error) {
  const response = error?.response && typeof error.response === "object" ? error.response : {};
  const issue = Array.isArray(response.issues) ? response.issues[0] : null;
  if (issue) {
    return {
      code: String(issue.code || "invalid_output"),
      path: String(issue.path || "$"),
      message: String(issue.message || "The server rejected the result contract."),
    };
  }
  for (const [field, value] of Object.entries(response)) {
    const message = Array.isArray(value) ? value[0] : value;
    if (typeof message === "string" && message.trim()) {
      return { code: "invalid_output", path: `$.${field}`, message: message.trim() };
    }
  }
  return { code: "invalid_output", path: "$", message: "The server rejected the result contract." };
}
