// Live-bridge chat: keeps one persistent ACP session per open chat session and
// pumps the server-side transcript both ways. The workspace is pull-only, so
// the loop long-polls `chat/sync` for user input and posts everything the
// agent produces back as idempotent transcript events.
import { spawn } from "node:child_process";
import readline from "node:readline";

import { mapAcpUpdate } from "./acp_client.mjs";

const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVITY_FLUSH_MS = 800;
const SYNC_WAIT_SECONDS = 15;
const ERROR_BACKOFF_MS = 3000;

export function openAcpChatSession(cfg, { cwd, env, onActivity, onPermissionRequest, spawnImpl = spawn } = {}) {
  const child = spawnImpl(cfg.acpBin, cfg.acpArgs || [], {
    cwd: cwd || cfg.acpCwd || cfg.codexCwd || process.cwd(),
    env: env || { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let sessionId = "";
  let stderr = "";
  let closed = false;
  let turn = null; // { output, resolve, timer }

  const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  const notify = (method, params) => write({ method, params });

  const close = (reason = "closed") => {
    if (closed) return;
    closed = true;
    reader.close();
    for (const slot of pending.values()) slot.reject(new Error("ACP chat session " + reason));
    pending.clear();
    if (turn) {
      turn.resolve({ status: "error", error: "ACP chat session " + reason });
      turn = null;
    }
    if (!child.killed) child.kill("SIGTERM");
  };

  child.stderr.on("data", (data) => {
    stderr += String(data);
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  child.on("error", () => close("failed to start"));
  child.on("close", () => close("exited: " + stderr.slice(-300)));

  reader.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else slot.resolve(message.result);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      if (message.method === "session/request_permission") {
        Promise.resolve(onPermissionRequest({ kind: "tool_permission", params: message.params }))
          .then((approve) => {
            const options = Array.isArray(message.params?.options) ? message.params.options : [];
            const preferred = approve ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
            const selected = preferred
              .map((optionKind) => options.find((option) => option.kind === optionKind))
              .find(Boolean);
            write({
              id: message.id,
              result: selected
                ? { outcome: { outcome: "selected", optionId: selected.optionId } }
                : { outcome: { outcome: "cancelled" } },
            });
          })
          .catch(() => write({ id: message.id, result: { outcome: { outcome: "cancelled" } } }));
        return;
      }
      if (message.method === "elicitation/create") {
        Promise.resolve(onPermissionRequest({ kind: "human_input", params: message.params }))
          .then((approve) =>
            write({ id: message.id, result: approve ? { action: "accept", content: {} } : { action: "cancel" } })
          )
          .catch(() => write({ id: message.id, result: { action: "cancel" } }));
        return;
      }
      write({ id: message.id, error: { code: -32601, message: "Not implemented: " + message.method } });
      return;
    }
    if (message.method === "session/update") {
      const update = message.params?.update || {};
      if (turn && update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        turn.output += update.content.text || "";
      }
      const event = mapAcpUpdate(update);
      if (event) {
        try {
          onActivity(event);
        } catch {
          // Activity reporting must never break the session.
        }
      }
    }
  });

  const ready = (async () => {
    const initialized = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {}, url: {} },
      },
      clientInfo: { name: "nuanu-flow-chat", version: "1" },
    });
    if (initialized?.protocolVersion !== 1) {
      throw new Error("ACP protocol negotiation failed");
    }
    if (Array.isArray(initialized.authMethods) && initialized.authMethods.length > 0 && cfg.acpAuthMethod) {
      await request("authenticate", { methodId: cfg.acpAuthMethod });
    }
    const created = await request("session/new", { cwd: cwd || cfg.acpCwd || process.cwd(), mcpServers: [] });
    sessionId = created?.sessionId || "";
    if (!sessionId) throw new Error("ACP agent did not return a sessionId");
  })();

  return {
    ready,
    get alive() {
      return !closed;
    },
    async prompt(text) {
      await ready;
      if (closed) return { status: "error", error: "session closed" };
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (sessionId) notify("session/cancel", { sessionId });
          if (turn) {
            turn.resolve({ status: "error", error: "prompt timed out" });
            turn = null;
          }
        }, PROMPT_TIMEOUT_MS);
        turn = { output: "", resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        } };
        request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
          .then((response) => {
            const current = turn;
            turn = null;
            if (!current) return;
            if (response?.stopReason === "refusal") current.resolve({ status: "error", error: "The agent refused." });
            else current.resolve({ status: "ok", output: current.output.trim() });
          })
          .catch((error) => {
            const current = turn;
            turn = null;
            if (current) current.resolve({ status: "error", error: error.message });
          });
      });
    },
    close,
  };
}

export function startChatLoop({ client, cfg, isRunning, log = () => {} }) {
  const sessions = new Map(); // session_id -> bridge state

  const bridgeFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (state) return state;
    state = {
      cursor: 0,
      queue: Promise.resolve(),
      activityBuffer: [],
      activityTimer: null,
      activityCounter: 0,
      pendingPermissions: new Map(), // request event seq -> resolve(approve)
      acp: null,
    };
    sessions.set(sessionId, state);
    return state;
  };

  const post = async (sessionId, events) => {
    if (!events.length) return [];
    const response = await client.chatPostEvents(sessionId, events);
    return response?.events || [];
  };

  const flushActivity = (sessionId, state) => {
    if (state.activityTimer) return;
    state.activityTimer = setTimeout(() => {
      state.activityTimer = null;
      const batch = state.activityBuffer.splice(0, 20);
      if (!batch.length) return;
      post(sessionId, batch).catch(() => {
        // Dropped activity is cosmetic; messages and permissions are retried.
      });
    }, ACTIVITY_FLUSH_MS);
  };

  const openBridge = async (sessionId, state) => {
    state.acp = openAcpChatSession(cfg, {
      onActivity: (event) => {
        state.activityCounter += 1;
        state.activityBuffer.push({
          kind: "activity",
          payload: event,
          client_key: `act:${sessionId}:${state.activityCounter}`,
        });
        flushActivity(sessionId, state);
      },
      onPermissionRequest: async ({ kind, params }) => {
        const summary =
          kind === "human_input"
            ? String(params?.message || "The agent needs your input.")
            : String(params?.toolCall?.title || params?.toolCall?.kind || "Tool call");
        const [created] = await post(sessionId, [
          {
            kind: "permission_request",
            payload: { request_kind: kind, summary, tool_kind: params?.toolCall?.kind || "" },
          },
        ]);
        if (!created) return false;
        return await new Promise((resolve) => {
          state.pendingPermissions.set(created.seq, resolve);
        });
      },
    });
    await state.acp.ready;
    await post(sessionId, [
      { kind: "state", payload: { state: "active" }, client_key: `state:${sessionId}:active` },
    ]);
  };

  const handleSession = (row) => {
    const sessionId = row.session.id;
    const state = bridgeFor(sessionId);
    for (const event of row.events) {
      if (event.seq <= state.cursor) continue;
      state.cursor = event.seq;
      if (event.kind === "permission_resolution") {
        const requestSeq = Number(event.payload?.request_seq || 0);
        const resolve = state.pendingPermissions.get(requestSeq);
        if (resolve) {
          state.pendingPermissions.delete(requestSeq);
          resolve(Boolean(event.payload?.approve));
        }
        continue;
      }
      if (event.kind === "state" && event.payload?.state === "close_requested") {
        state.queue = state.queue.then(async () => {
          if (state.acp) state.acp.close();
          await post(sessionId, [
            { kind: "state", payload: { state: "closed", reason: "user" }, client_key: `state:${sessionId}:closed` },
          ]).catch(() => {});
          sessions.delete(sessionId);
        });
        continue;
      }
      if (event.kind === "user_message") {
        const text = String(event.payload?.text || "");
        state.queue = state.queue.then(async () => {
          if (!state.acp || !state.acp.alive) await openBridge(sessionId, state);
          const result = await state.acp.prompt(text);
          const payload =
            result.status === "ok"
              ? { text: result.output }
              : { text: "The agent hit an error: " + (result.error || "unknown"), error: true };
          await post(sessionId, [
            { kind: "assistant_message", payload, client_key: `asst:${sessionId}:${event.seq}` },
          ]);
        });
      }
    }
    if (row.session.status === "requested" && !state.acp) {
      state.queue = state.queue.then(async () => {
        if (!state.acp) await openBridge(sessionId, state);
      });
    }
    state.queue = state.queue.catch(async (error) => {
      log("chat session " + sessionId + " failed: " + error.message);
      if (state.acp) state.acp.close();
      sessions.delete(sessionId);
      await post(sessionId, [
        {
          kind: "state",
          payload: { state: "failed", reason: String(error.message || "bridge error").slice(0, 200) },
        },
      ]).catch(() => {});
    });
  };

  return (async () => {
    while (isRunning()) {
      try {
        const cursors = {};
        for (const [sessionId, state] of sessions) cursors[sessionId] = state.cursor;
        const response = await client.chatSync({ cursors, waitSeconds: SYNC_WAIT_SECONDS });
        for (const row of response?.sessions || []) handleSession(row);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
      }
    }
    for (const state of sessions.values()) if (state.acp) state.acp.close();
  })();
}
