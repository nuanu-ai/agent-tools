import { spawn } from "node:child_process";
import readline from "node:readline";

const CLIENT_INFO = {
  name: "nuanu-flow-worker",
  title: "Nuanu Flow Worker",
  version: "0.1.0",
};

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function acpMcpServers(task) {
  const descriptor = task.internal_mcp;
  const servers = [];
  if (descriptor?.transport === "streamable_http" && descriptor.url && task.agent_key) {
    servers.push({
      type: "http",
      name: "nuanu-flow",
      url: descriptor.url,
      headers: [
        { name: descriptor.authentication?.header || "X-Agent-Key", value: task.agent_key },
        { name: descriptor.workspace_header || "X-Plane-Workspace", value: task.workspace },
      ],
    });
  }
  for (const connection of task.runtime_mcp_servers || []) {
    const transport = connection.transport === "streamable_http" ? "http" : connection.transport;
    if (!connection?.url || !["http", "sse"].includes(transport)) continue;
    servers.push({
      type: transport,
      name: connection.name || connection.server_id || connection.id || "external-mcp",
      url: connection.url,
      headers: Array.isArray(connection.headers)
        ? connection.headers
            .filter((header) => header?.name && header?.value)
            .map((header) => ({ name: String(header.name), value: String(header.value) }))
        : Object.entries(connection.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
    });
  }
  return servers;
}

export function selectAcpPermission(params, task, mode = "auto") {
  const options = Array.isArray(params?.options) ? params.options : [];
  const kind = params?.toolCall?.kind || "other";
  const normalizedMode = String(mode || "auto").toLowerCase();
  const repositoryGranted = Boolean(task.request?.authority_grants?.repository);
  const safeRead = ["read", "search", "think", "fetch"].includes(kind);
  const scopedWrite = repositoryGranted && ["edit", "move", "execute"].includes(kind);
  const allow =
    ["allow", "approve", "accept"].includes(normalizedMode) || (normalizedMode === "auto" && (safeRead || scopedWrite));
  const preferredKinds = allow ? ["allow_once"] : ["reject_once", "reject_always"];
  const selected = preferredKinds
    .map((optionKind) => options.find((option) => option.kind === optionKind))
    .find(Boolean);
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function acpHumanInputRequest(params, requestId) {
  const message = String(params?.message || "Provide the information needed to continue.");
  if (params?.mode === "url") {
    const url = String(params.url || params.urlHint || "");
    return {
      title: "Authentication required",
      body: url ? message + "\n\n" + url : message,
      choices: [
        { value: "completed", label: "I've completed login" },
        { value: "cancelled", label: "Cancel" },
      ],
      blocking: true,
      idempotency_key: "acp:" + requestId,
    };
  }
  const schema = params?.requestedSchema || params?.schema || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(schema.properties || {})
    .slice(0, 5)
    .map(([key, property]) => {
      const values = Array.isArray(property.enum)
        ? property.enum
        : Array.isArray(property.oneOf)
          ? property.oneOf.map((option) => option?.const).filter((value) => value !== undefined)
          : [];
      return {
        key,
        label: property.title || key,
        description: property.description || "",
        type:
          values.length > 0
            ? "select"
            : property.type === "number" || property.type === "integer"
              ? "number"
              : property.type === "boolean"
                ? "boolean"
                : "text",
        required: required.has(key),
        ...(values.length > 0
          ? { options: values.map((value) => ({ value: String(value), label: String(value) })) }
          : {}),
      };
    });
  return {
    title: schema.title || "Human input needed",
    body: message,
    fields,
    blocking: true,
    idempotency_key: "acp:" + requestId,
  };
}

export function mapAcpUpdate(update) {
  const type = update?.sessionUpdate;
  if (type === "tool_call" || type === "tool_call_update") {
    const state = String(update.status || (type === "tool_call" ? "started" : "updated"));
    const completed = ["completed", "success", "succeeded"].includes(state);
    const failed = ["failed", "error", "cancelled"].includes(state);
    return {
      schema_version: "nuanu.agent-activity.v1",
      kind: "activity",
      summary: failed ? "Tool failed" : completed ? "Tool completed" : "Using a tool",
      ...(update.toolCallId ? { activity_id: String(update.toolCallId) } : {}),
      data: {
        category: "tool",
        state: failed ? "failed" : completed ? "completed" : type === "tool_call" ? "started" : "updated",
        ...(typeof update.kind === "string" && /^[a-z0-9._-]+$/i.test(update.kind)
          ? { tool_kind: update.kind.toLowerCase() }
          : {}),
      },
    };
  }
  if (type === "plan" || type === "plan_update" || type === "plan_removed") {
    return {
      schema_version: "nuanu.agent-activity.v1",
      kind: "activity",
      summary:
        type === "plan"
          ? "Created an execution plan"
          : type === "plan_removed"
            ? "Cleared the execution plan"
            : "Updated the execution plan",
      activity_id: "acp:plan",
      data: {
        category: "plan",
        state: type === "plan" ? "started" : type === "plan_removed" ? "completed" : "updated",
      },
    };
  }
  if (type === "usage_update") {
    // Usage can update for every model chunk. The durable task metrics already
    // capture it, so do not amplify it into Redis and workspace realtime.
    return null;
  }
  return null;
}

export function runAcpTask(task, cfg, prompt, taskEnv, { spawnImpl = spawn, onActivity = () => {} } = {}) {
  return new Promise((resolve) => {
    const cwd = task._worktree_path || cfg.acpCwd || cfg.codexCwd || process.cwd();
    const child = spawnImpl(cfg.acpBin, cfg.acpArgs || [], {
      cwd,
      env: taskEnv || { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;
    let sessionId = "";
    let output = "";
    let stderr = "";
    let settled = false;

    const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
    const notify = (method, params) => write({ method, params });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.close();
      for (const slot of pending.values()) slot.reject(new Error("ACP task finished"));
      pending.clear();
      if (!child.killed) child.kill("SIGTERM");
      resolve({ ...result, events: [], meta: { ...(result.meta || {}), session_id: sessionId, acp: true } });
    };
    const timer = setTimeout(() => {
      if (sessionId) notify("session/cancel", { sessionId });
      finish({ status: "error", error: "ACP agent timed out after " + cfg.timeoutMs + "ms" });
    }, cfg.timeoutMs);

    child.stderr.on("data", (data) => {
      stderr += String(data);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (error) => finish({ status: "error", error: "ACP agent failed to start: " + error.message }));
    child.on("close", (code) => {
      if (!settled) finish({ status: "error", error: "ACP agent exited " + code + ": " + stderr.slice(-500) });
    });

    reader.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        stderr += "\n[ACP non-JSON stdout] " + line.slice(0, 500);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
        const slot = pending.get(message.id);
        if (!slot) return;
        pending.delete(message.id);
        if (message.error) slot.reject(new Error(message.error.message || safeJson(message.error)));
        else slot.resolve(message.result);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
        if (message.method === "session/request_permission") {
          write({ id: message.id, result: selectAcpPermission(message.params, task, cfg.acpPermissionMode) });
          return;
        }
        if (message.method === "elicitation/create") {
          const humanRequest = acpHumanInputRequest(message.params, message.id);
          write({ id: message.id, result: { action: "cancel" } });
          if (sessionId) notify("session/cancel", { sessionId });
          finish({ status: "waiting_input", request: humanRequest });
          return;
        }
        write({
          id: message.id,
          error: { code: -32601, message: "Nuanu Flow ACP client does not implement " + message.method },
        });
        return;
      }
      if (message.method === "session/update") {
        const update = message.params?.update || {};
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
          output += update.content.text || "";
        }
        const event = mapAcpUpdate(update);
        if (event) {
          try {
            onActivity(event);
          } catch {
            // Optional Process activity must never change ACP execution.
          }
        }
      }
    });

    (async () => {
      try {
        const initialized = await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            elicitation: { form: {}, url: {} },
          },
          clientInfo: CLIENT_INFO,
        });
        if (initialized?.protocolVersion !== 1) {
          throw new Error("ACP protocol negotiation returned unsupported version " + initialized?.protocolVersion);
        }
        if (Array.isArray(initialized.authMethods) && initialized.authMethods.length > 0 && cfg.acpAuthMethod) {
          await request("authenticate", { methodId: cfg.acpAuthMethod });
        }
        const created = await request("session/new", {
          cwd,
          mcpServers: acpMcpServers(task),
          _meta: {
            "nuanu.dev/task-id": task.task_id,
            "nuanu.dev/process-run-id": task.run_id,
            "nuanu.dev/step-id": task.step_id,
          },
        });
        sessionId = created?.sessionId || "";
        if (!sessionId) throw new Error("ACP agent did not return a sessionId");
        const response = await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        if (response?.stopReason === "cancelled") {
          finish({ status: "error", error: "ACP agent cancelled the task" });
          return;
        }
        if (response?.stopReason === "refusal") {
          finish({ status: "error", error: "ACP agent refused the task" });
          return;
        }
        if (!output.trim()) throw new Error("ACP agent completed without an agent message");
        finish({ status: "ok", output: output.trim() });
      } catch (error) {
        finish({ status: "error", error: "ACP handshake or prompt failed: " + error.message });
      }
    })();
  });
}
