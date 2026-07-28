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
  const type = item?.type || "";
  const summaries = {
    commandExecution:
      phase === "started" ? "Running a command" : "Command finished",
    fileChange:
      phase === "started" ? "Preparing file changes" : "Files updated",
    mcpToolCall:
      phase === "started" ? "Using a connected tool" : "Connected tool finished",
    dynamicToolCall:
      phase === "started" ? "Using a tool" : "Tool finished",
    webSearch:
      phase === "started" ? "Searching the web" : "Web search finished",
    imageGeneration:
      phase === "started" ? "Generating an image" : "Image generation finished",
  };
  const safeSummary = summaries[type];
  return safeSummary
    ? { kind: "task.progress", safe_summary: safeSummary }
    : null;
}

export function classifyAppServerActivity(msg) {
  const method = msg?.method || "";
  if (method === "turn/started") {
    return { kind: "task.started", safe_summary: "Codex execution started" };
  }
  if (method === "item/started") {
    return itemActivity(msg.params?.item, "started");
  }
  if (method === "item/completed") {
    return itemActivity(msg.params?.item, "completed");
  }
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
  if (
    method === "mcpServer/elicitation/request" ||
    method === "item/tool/requestUserInput"
  ) {
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
    // Activity reporting must never change task execution.
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

  if (method === "mcpServer/elicitation/request") {
    return { result: { action: "decline", content: null } };
  }

  if (method === "item/tool/requestUserInput") {
    return { result: { answers: {} } };
  }

  return {
    error: {
      code: -32601,
      message: `Nuanu Flow worker does not implement App Server request ${method}`,
    },
  };
}

export function runCodexAppServerTask(
  task,
  cfg,
  prompt,
  taskEnv,
  { onActivity } = {},
) {
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
    const pending = new Map();

    const child = spawn(cfg.codexBin, args, {
      env,
      cwd: cfg.codexCwd,
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
          meta: { thread_id: threadId, turn_id: turnId, app_server: true },
        });
        return;
      }

      if (msg.method === "error") {
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
        const approvalPolicy = cfg.codexAppServerApprovalPolicy || "never";
        const thread = await request("thread/start", {
          cwd: cfg.codexCwd,
          approvalPolicy,
          ephemeral: true,
          serviceName: "nuanu-flow-worker",
        });
        threadId = thread?.thread?.id || thread?.threadId || thread?.id || "";
        if (!threadId) throw new Error("codex app-server did not return a thread id");

        const turnParams = {
          threadId,
          input: [{ type: "text", text: prompt }],
          cwd: cfg.codexCwd,
          approvalPolicy,
        };
        if (task.output_schema && typeof task.output_schema === "object") {
          turnParams.outputSchema = task.output_schema;
        }
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
