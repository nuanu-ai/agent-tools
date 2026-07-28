const INSTALLATION_STATES = new Set(["installed"]);
const AUTHENTICATION_STATES = new Set(["connected", "skipped"]);
const ATTACHMENT_STATES = new Set([
  "attached",
  "reload_required",
  "restart_required",
  "verification_required",
]);
const CONTINUATION_STATES = new Set([
  "automatic",
  "same_conversation_command",
  "same_thread_resume",
  "verify_in_current_thread",
]);
const ATTACHMENT_CONTINUATIONS = new Map([
  ["attached", "automatic"],
  ["reload_required", "same_conversation_command"],
  ["restart_required", "same_thread_resume"],
  ["verification_required", "verify_in_current_thread"],
]);

function requireState(allowed, value, label) {
  if (!allowed.has(value)) {
    throw new Error(
      `Invalid plugin lifecycle ${label}: ${String(value || "missing")}`,
    );
  }
  return value;
}

export function createPluginLifecycle({
  surface,
  installation = "installed",
  authentication,
  attachment,
  continuation,
}) {
  if (typeof surface !== "string" || !surface.trim()) {
    throw new Error("Plugin lifecycle surface must be a non-empty string");
  }
  const lifecycle = {
    surface,
    installation: requireState(
      INSTALLATION_STATES,
      installation,
      "installation",
    ),
    authentication: requireState(
      AUTHENTICATION_STATES,
      authentication,
      "authentication",
    ),
    attachment: requireState(ATTACHMENT_STATES, attachment, "attachment"),
    continuation: requireState(
      CONTINUATION_STATES,
      continuation,
      "continuation",
    ),
  };
  const expectedContinuation = ATTACHMENT_CONTINUATIONS.get(
    lifecycle.attachment,
  );
  if (lifecycle.continuation !== expectedContinuation) {
    throw new Error(
      `Plugin lifecycle ${lifecycle.attachment} requires continuation ${expectedContinuation}`,
    );
  }
  return lifecycle;
}

export function attachmentAction(lifecycle) {
  switch (lifecycle?.attachment) {
    case "attached":
      return "none";
    case "reload_required":
      return "reload";
    case "restart_required":
      return "restart";
    case "verification_required":
      return "verify";
    default:
      throw new Error(
        `Unknown plugin attachment state: ${String(
          lifecycle?.attachment || "missing",
        )}`,
      );
  }
}
