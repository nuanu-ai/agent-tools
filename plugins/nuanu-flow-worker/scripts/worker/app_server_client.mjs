import { spawn } from "node:child_process";
import readline from "node:readline";

const CLIENT_INFO = {
  name: "nuanu-flow-worker",
  title: "Nuanu Flow Worker",
  version: "0.1.0",
};

function isApproveMode(mode) {
  return /^(approve|accept|allow)$/i.test(String(mode || ""));
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function appServerErrorWillRetry(params) {
  return params?.willRetry === true || params?.error?.willRetry === true || params?.message?.willRetry === true;
}

function turnErrorMessage(turn) {
  if (!turn?.error) return `turn ended with status ${turn?.status || "unknown"}`;
  if (typeof turn.error === "string") return turn.error;
  if (turn.error.message) return turn.error.message;
  return safeJson(turn.error);
}

function extractTextFromItem(item) {
  if (!item || item.type !== "agentMessage") return "";
  return typeof item.text === "string" ? item.text.trim() : "";
}

function itemActivity(item, phase) {
  const summaries = {
    commandExecution: phase === "started" ? "Running a command" : "Command finished",
    fileChange: phase === "started" ? "Preparing file changes" : "Files updated",
    mcpToolCall: phase === "started" ? "Using a connected tool" : "Connected tool finished",
    dynamicToolCall: phase === "started" ? "Using a tool" : "Tool finished",
    webSearch: phase === "started" ? "Searching the web" : "Web search finished",
    imageGeneration: phase === "started" ? "Generating an image" : "Image generation finished",
  };
  const safeSummary = summaries[item?.type || ""];
  return safeSummary
    ? {
        kind: "task.progress",
        safe_summary: safeSummary,
        ...(item?.id ? { activity_id: String(item.id) } : {}),
        category:
          item?.type === "fileChange"
            ? "file_change"
            : item?.type === "webSearch"
              ? "research"
              : item?.type === "imageGeneration"
                ? "artifact"
                : "tool",
        state: phase === "started" ? "started" : "completed",
      }
    : null;
}

export function classifyAppServerActivity(msg) {
  const method = msg?.method || "";
  if (method === "turn/started") {
    return { kind: "task.started", safe_summary: "Codex execution started" };
  }
  if (method === "item/started") return itemActivity(msg.params?.item, "started");
  if (method === "item/completed") return itemActivity(msg.params?.item, "completed");
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval" ||
    method === "item/permissions/requestApproval"
  ) {
    return {
      kind: "task.attention",
      safe_summary: "An approval was requested and handled by worker policy",
    };
  }
  if (method === "mcpServer/elicitation/request" || method === "item/tool/requestUserInput") {
    return {
      kind: "task.attention",
      safe_summary: "The headless task requested user input",
    };
  }
  return null;
}

function emitActivity(onActivity, event) {
  if (!event || typeof onActivity !== "function") return;
  try {
    onActivity(event);
  } catch {
    // Optional activity reporting must never change task execution.
  }
}

export function extractAgentOutputFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const text = extractTextFromItem(items[i]);
    if (text) return text;
  }
  return "";
}

export function humanInputRequest(msg) {
  const method = msg?.method || "";
  const params = msg?.params || {};
  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    if (questions.length === 0) return null;
    if (questions.length === 1 && Array.isArray(questions[0]?.options) && questions[0].options.length > 0) {
      const question = questions[0];
      return {
        title: question.header || "Human decision needed",
        body: question.question || "Choose how the agent should continue.",
        choices: question.options.map((option) => ({
          value: option.label,
          label: option.label,
          description: option.description || "",
        })),
        blocking: true,
        idempotency_key: `codex:${msg.id}`,
      };
    }
    return {
      title: questions[0]?.header || "Human input needed",
      body: questions
        .map((question) => question.question)
        .filter(Boolean)
        .join("\n\n"),
      fields: questions.slice(0, 5).map((question, index) => ({
        key: question.id || `answer_${index + 1}`,
        label: question.header || question.question || `Answer ${index + 1}`,
        type: Array.isArray(question.options) && question.options.length > 0 ? "select" : "text",
        required: true,
        ...(Array.isArray(question.options) && question.options.length > 0
          ? { options: question.options.map((option) => ({ value: option.label, label: option.label })) }
          : {}),
      })),
      blocking: true,
      idempotency_key: `codex:${msg.id}`,
    };
  }
  if (method === "mcpServer/elicitation/request") {
    if (params.mode === "url") {
      const url = typeof params.url === "string" ? params.url.trim() : "";
      if (!url) return null;
      return {
        title: "Action needed to continue",
        body: [params.message || "Open the link to continue.", url].filter(Boolean).join("\n\n"),
        choices: [
          {
            value: "ready",
            label: "Ready",
            description: "I completed the requested action; retry the connected tool.",
          },
          {
            value: "cancel",
            label: "Cancel",
            description: "Do not continue with this connected tool.",
          },
        ],
        blocking: true,
        idempotency_key: `mcp:${msg.id}`,
      };
    }
    const schema = params.requestedSchema || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(schema.properties || {})
      .slice(0, 5)
      .map(([key, property]) => ({
        key,
        label: property.title || key,
        description: property.description || "",
        type: Array.isArray(property.enum)
          ? "select"
          : property.type === "number" || property.type === "integer"
            ? "number"
            : property.type === "boolean"
              ? "boolean"
              : "text",
        required: required.has(key),
        ...(Array.isArray(property.enum)
          ? { options: property.enum.map((value) => ({ value: String(value), label: String(value) })) }
          : {}),
      }));
    if (fields.length === 0) return null;
    return {
      title: "Human input needed",
      body: params.message || "Provide the information needed to continue.",
      fields,
      blocking: true,
      idempotency_key: `mcp:${msg.id}`,
    };
  }
  return null;
}

export function codexOutputSchema(schema) {
  let value = schema;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) {
    return value && typeof value === "object" ? value : null;
  }
  const properties = {};
  const required = [];
  for (const field of value) {
    if (!field || typeof field !== "object") continue;
    const key = String(field.key || field.name || "").trim();
    if (!key) continue;
    let property;
    if (field.type === "array") property = { type: "array", items: {} };
    else if (field.type === "object") property = { type: "object", additionalProperties: true };
    else if (field.type === "number") property = { type: "number" };
    else if (field.type === "boolean") property = { type: "boolean" };
    else property = { type: "string" };
    if (Array.isArray(field.enumValues) && field.enumValues.length > 0) property.enum = field.enumValues;
    if (field.description) property.description = String(field.description);
    properties[key] = property;
    required.push(key);
  }
  return required.length > 0 ? { type: "object", properties, required, additionalProperties: false } : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function supportsStrictOutput(definition) {
  return Object.values(definition?.data || {}).every((field) => {
    if (field?.type === "choices") return false;
    if (field?.type !== "json") return true;
    return field.schema && typeof field.schema === "object" && !Array.isArray(field.schema);
  });
}

function authoredDataSchema(definition) {
  const properties = {};
  for (const [key, field] of Object.entries(definition?.data || {})) {
    if (field?.type === "string") properties[key] = { type: "string" };
    else if (field?.type === "number") properties[key] = { type: "number" };
    else if (field?.type === "boolean") properties[key] = { type: "boolean" };
    else if (field?.type === "choices") {
      properties[key] = {
        type: "object",
        propertyNames: { pattern: "^[a-z][a-z0-9_]{0,63}$" },
        additionalProperties: processItemDraftSchema(field.item || {}, null),
      };
    } else if (field?.type === "json" && field.schema) properties[key] = cloneJson(field.schema);
    else return null;
    if (field?.description) properties[key].description = String(field.description);
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function processItemDraftSchema(definition, expectedKey) {
  const data = authoredDataSchema(definition);
  if (!data) return null;
  return {
    type: "object",
    properties: {
      key: expectedKey ? { type: "string", const: expectedKey } : { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      description: { type: "string" },
      data,
      artifacts: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    required: ["key", "description", "data", "artifacts"],
    additionalProperties: false,
  };
}

function strictObject(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function artifactReferenceSchema(kind) {
  return strictObject({
    mode: { type: "string", const: "reference" },
    artifact: strictObject({
      artifact_id: { type: "string" },
      version_id: { type: "string" },
      kind: { type: "string", const: kind },
      role: { type: "string", const: "output" },
    }),
  });
}

function artifactCandidateSchema(kind) {
  let locator = null;
  if (kind === "git.commit") locator = strictObject({ sha: { type: "string" } });
  else if (kind === "git.branch") locator = strictObject({ branch: { type: "string" } });
  else if (kind === "git.pull_request") locator = strictObject({ number: { type: "integer" } });
  else if (kind === "external.link") locator = strictObject({ url: { type: "string" } });
  if (!locator) return null;
  return strictObject({
    mode: { type: "string", const: "candidate" },
    candidate: strictObject({
      client_id: { type: "string" },
      name: { type: "string" },
      locator,
    }),
  });
}

function artifactOutputSchema(definition) {
  const kind = String(definition?.kind || "");
  const alternatives = [artifactReferenceSchema(kind)];
  const candidate = artifactCandidateSchema(kind);
  if (candidate) alternatives.push(candidate);
  // Dynamic publication and repository verification may fill a declared output
  // after the model returns. Null keeps that placeholder explicit and required.
  alternatives.push({ type: "null" });
  return { anyOf: alternatives };
}

export function processItemCompletionOutputSchema(task) {
  const definition = task?.request?.output_definition || { data: {}, artifacts: {} };
  if (!supportsStrictOutput(definition)) return null;
  const itemSchema = processItemDraftSchema(definition, String(task?.request?.process?.step_key || ""));
  if (!itemSchema) return null;
  const artifactProperties = Object.fromEntries(
    Object.entries(definition.artifacts || {}).map(([key, artifactDefinition]) => [
      `item.artifacts.${key}`,
      artifactOutputSchema(artifactDefinition),
    ])
  );
  return {
    type: "object",
    properties: {
      item: itemSchema,
      artifact_outputs: {
        type: "object",
        properties: artifactProperties,
        required: Object.keys(artifactProperties),
        additionalProperties: false,
      },
    },
    required: ["item", "artifact_outputs"],
    additionalProperties: false,
  };
}

function serverRequestResponse(msg, cfg) {
  const approve = isApproveMode(cfg.codexAppServerApprovalMode);
  const method = msg.method || "";

  if (method === "item/commandExecution/requestApproval") {
    return { result: { decision: approve ? "accept" : "decline" } };
  }

  if (method === "item/fileChange/requestApproval") {
    return { result: { decision: approve ? "accept" : "decline" } };
  }

  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return {
      result: approve
        ? { decision: "approved" }
        : { decision: { denied: { rejection: "Denied by Nuanu Flow worker policy." } } },
    };
  }

  if (method === "item/permissions/requestApproval") {
    if (approve) {
      return { result: { permissions: msg.params?.permissions || {}, scope: "turn" } };
    }
    return {
      error: {
        code: -32001,
        message: "Permission request denied by Nuanu Flow worker policy.",
      },
    };
  }

  return {
    error: {
      code: -32601,
      message: `Nuanu Flow worker does not implement App Server request ${method}`,
    },
  };
}

function taskMcpConfig(task, cfg) {
  const descriptor = task?.internal_mcp;
  if (descriptor?.transport !== "streamable_http" || !descriptor.url || !task?.agent_key) {
    throw new Error("capability_unavailable: internal Nuanu Flow MCP is unavailable");
  }
  const authHeader = descriptor.authentication?.header || "X-Agent-Key";
  const workspaceHeader = descriptor.workspace_header || "X-Plane-Workspace";
  return {
    mcp_servers: {
      nuanu_flow_task: {
        url: descriptor.url,
        required: true,
        startup_timeout_sec: 20,
        tool_timeout_sec: 120,
        http_headers: {
          [workspaceHeader]: task.workspace,
          "X-Agent-Client": "Nuanu Flow Worker",
        },
        env_http_headers: {
          [authHeader]: cfg.codexAgentKeyEnv || "NUANU_AGENT_KEY",
        },
      },
    },
  };
}

function executionRoots(task, taskRoot, cfg) {
  const cwd = task?._worktree_path || taskRoot || cfg?.codexCwd;
  const repositoryWritable = Object.values(task?.request?.output_definition?.artifacts || {}).some((artifact) =>
    ["git.commit", "git.branch"].includes(String(artifact?.kind))
  );
  const roots = [...new Set([repositoryWritable ? cwd : null, taskRoot].filter(Boolean))];
  return { cwd, roots };
}

export function codexThreadStartParams(task, cfg, taskRoot, publisher = null) {
  const { cwd, roots } = executionRoots(task, taskRoot, cfg);
  const model = String(task?.configuration_snapshot?.model || cfg?.codexAppServerModel || "").trim();
  const params = {
    cwd,
    runtimeWorkspaceRoots: roots,
    sandbox: "workspace-write",
    approvalPolicy: cfg.codexAppServerApprovalPolicy || "never",
    ephemeral: true,
    serviceName: "nuanu-flow-worker",
    config: taskMcpConfig(task, cfg),
  };
  if (model) params.model = model;
  if (publisher?.spec) params.dynamicTools = [publisher.spec];
  return params;
}

export function codexTurnStartParams(threadId, prompt, taskRoot, task = {}, cfg = {}) {
  const { cwd, roots } = executionRoots(task, taskRoot, cfg);
  const model = String(task?.configuration_snapshot?.model || cfg?.codexAppServerModel || "").trim();
  const effort = String(
    task?.configuration_snapshot?.inference_config?.reasoning_effort || cfg?.codexAppServerReasoningEffort || ""
  ).trim();
  return {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd,
    approvalPolicy: cfg.codexAppServerApprovalPolicy || "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: roots,
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function safeToolContent(value) {
  return [{ type: "inputText", text: JSON.stringify(value) }];
}

export async function dispatchDynamicToolCall(msg, publisher, { onActivity = () => {}, onPublished = () => {} } = {}) {
  const toolName = msg?.params?.tool || msg?.params?.name;
  if (msg?.method !== "item/tool/call" || toolName !== publisher?.spec?.name) {
    onActivity({ phase: "artifact_tool_rejected", code: "unknown_tool" });
    return {
      success: false,
      contentItems: safeToolContent({ error: { code: "unknown_tool", message: "Dynamic tool is unavailable" } }),
    };
  }
  try {
    onActivity({ phase: "artifact_tool_started" });
    const result = await publisher.call(msg.params?.arguments || {});
    onPublished(result);
    onActivity({ phase: "artifact_tool_completed", kind: result.artifact?.kind, role: result.artifact?.role });
    return { success: true, contentItems: safeToolContent(result) };
  } catch (error) {
    const code = /^[a-z][a-z0-9_]{1,63}$/.test(String(error?.code || ""))
      ? String(error.code)
      : "artifact_publication_failed";
    onActivity({ phase: "artifact_tool_failed", code });
    const safeMessage = ["invalid_input", "invalid_output"].includes(code)
      ? String(error.message || "Artifact publication failed").slice(0, 500)
      : "Artifact publication failed";
    return {
      success: false,
      contentItems: safeToolContent({ error: { code, message: safeMessage } }),
    };
  }
}

export function runCodexAppServerTask(task, cfg, prompt, taskEnv, context = {}) {
  return new Promise((resolve) => {
    const args = [...cfg.codexAppServerArgs];
    const env = taskEnv || { ...process.env };
    if (!taskEnv && task.agent_key) env.NUANU_AGENT_KEY = task.agent_key;

    let stderr = "";
    let settled = false;
    let nextId = 1;
    let threadId = "";
    let turnId = "";
    let deltaOutput = "";
    let completedItemOutput = "";
    const publishedArtifacts = [];
    const pending = new Map();

    const taskRoot = context.taskRoot || task._task_root || task._worktree_path || cfg.codexCwd;
    const publisher = context.publisher || null;
    const onActivity = context.onActivity || (() => {});
    const taskCwd = task._worktree_path || taskRoot || cfg.codexCwd;
    const child = spawn(cfg.codexBin, args, {
      env,
      cwd: taskCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      for (const { reject } of pending.values()) reject(new Error("codex app-server task finished"));
      pending.clear();
      if (!child.killed) child.kill("SIGTERM");
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        status: "error",
        error: `codex app-server timed out after ${cfg.timeoutMs}ms`,
      });
    }, cfg.timeoutMs);

    const write = (msg) => {
      if (settled || child.stdin.destroyed) return;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    };

    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, method });
        write({ id, method, params });
      });

    const notify = (method, params) => write({ method, params });

    const rl = readline.createInterface({ input: child.stdout });

    child.stderr.on("data", (d) => {
      stderr += d;
    });

    child.on("error", (e) => {
      finish({ status: "error", error: `codex app-server failed to start: ${e.message}` });
    });

    child.on("close", (code) => {
      if (!settled) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "";
        finish({ status: "error", error: `codex app-server exited before turn completed (${code})${detail}` });
      }
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        stderr += `\n[app-server non-json stdout] ${line.slice(0, 500)}`;
        return;
      }

      if (Object.prototype.hasOwnProperty.call(msg, "id") && !msg.method) {
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message || safeJson(msg.error)));
        else slot.resolve(msg.result);
        return;
      }

      if (Object.prototype.hasOwnProperty.call(msg, "id") && msg.method) {
        emitActivity(onActivity, classifyAppServerActivity(msg));
        if (msg.method === "item/tool/call") {
          void dispatchDynamicToolCall(msg, publisher, {
            onActivity,
            onPublished: (artifact) => publishedArtifacts.push(artifact),
          }).then((result) => {
            write({ id: msg.id, result });
          });
          return;
        }
        const humanRequest = humanInputRequest(msg);
        if (humanRequest) {
          finish({
            status: "waiting_input",
            request: humanRequest,
            meta: { thread_id: threadId, turn_id: turnId, app_server: true },
          });
          return;
        }
        const response = serverRequestResponse(msg, cfg);
        write({ id: msg.id, ...response });
        return;
      }

      emitActivity(onActivity, classifyAppServerActivity(msg));

      if (msg.method === "item/agentMessage/delta") {
        deltaOutput += msg.params?.delta || "";
        return;
      }

      if (msg.method === "item/completed") {
        const text = extractTextFromItem(msg.params?.item);
        if (text) completedItemOutput = text;
        return;
      }

      if (msg.method === "turn/started") {
        turnId = msg.params?.turn?.id || msg.params?.turnId || turnId;
        return;
      }

      if (msg.method === "turn/completed") {
        const turn = msg.params?.turn;
        turnId = turn?.id || turnId;
        if (turn?.status && turn.status !== "completed") {
          finish({
            status: "error",
            error: turnErrorMessage(turn),
            meta: { thread_id: threadId, turn_id: turnId, app_server: true },
          });
          return;
        }
        const output = extractAgentOutputFromTurn(turn) || completedItemOutput || deltaOutput.trim();
        finish({
          status: "ok",
          output,
          publishedArtifacts,
          meta: { thread_id: threadId, turn_id: turnId, app_server: true },
        });
        return;
      }

      if (msg.method === "error") {
        if (appServerErrorWillRetry(msg.params)) {
          onActivity({ phase: "provider_retrying", code: "response_stream_disconnected" });
          return;
        }
        finish({
          status: "error",
          error: msg.params?.message || safeJson(msg.params || msg),
          meta: { thread_id: threadId, turn_id: turnId, app_server: true },
        });
      }
    });

    (async () => {
      try {
        await request("initialize", {
          clientInfo: CLIENT_INFO,
          capabilities: {
            experimentalApi: true,
            mcpServerOpenaiFormElicitation: true,
          },
        });
        notify("initialized", {});
        const thread = await request("thread/start", codexThreadStartParams(task, cfg, taskRoot, publisher));
        threadId = thread?.thread?.id || thread?.threadId || thread?.id || "";
        if (!threadId) throw new Error("codex app-server did not return a thread id");

        const turnParams = codexTurnStartParams(threadId, prompt, taskRoot, task, cfg);
        const outputSchema = processItemCompletionOutputSchema(task);
        if (outputSchema) turnParams.outputSchema = outputSchema;
        const turn = await request("turn/start", turnParams);
        turnId = turn?.turn?.id || turn?.turnId || turn?.id || turnId;
      } catch (e) {
        finish({
          status: "error",
          error: `codex app-server handshake failed: ${e.message}`,
          meta: { thread_id: threadId, turn_id: turnId, app_server: true },
        });
      }
    })();
  });
}
