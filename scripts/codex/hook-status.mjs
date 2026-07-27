import { spawn } from "node:child_process";
import readline from "node:readline";

const CLIENT_INFO = {
  name: "nuanu-flow-hook-doctor",
  title: "Nuanu Flow Hook Doctor",
  version: "0.1.0",
};

const TRUSTED_STATUSES = new Set(["trusted", "approved", "managed"]);

function hookStatusFromRows(rows, pluginId) {
  const hooks = (Array.isArray(rows) ? rows : [])
    .flatMap((row) => (Array.isArray(row?.hooks) ? row.hooks : []))
    .filter(
      (hook) =>
        hook?.pluginId === pluginId &&
        String(hook?.eventName || "")
          .replace(/[^A-Za-z]/g, "")
          .toLowerCase() === "sessionstart",
    );
  if (hooks.length === 0) {
    return {
      status: "unsupported",
      detail: "Nuanu Flow SessionStart hook was not discovered",
      hooks: [],
    };
  }
  const ready = hooks.every(
    (hook) =>
      hook.enabled !== false &&
      (hook.isManaged === true ||
        TRUSTED_STATUSES.has(
          String(hook.trustStatus || "").toLowerCase(),
        )),
  );
  return {
    status: ready ? "trusted" : "review_required",
    detail: ready
      ? "Nuanu Flow SessionStart hook is trusted"
      : "Nuanu Flow SessionStart hook needs one-time review",
    hooks: hooks.map((hook) => ({
      key: hook.key || "",
      enabled: hook.enabled !== false,
      trustStatus: hook.trustStatus || "",
      currentHash: hook.currentHash || "",
    })),
  };
}

export function readHookTrustStatus(options = {}) {
  return new Promise((resolve) => {
    const codexBin = options.codexBin || "codex";
    const cwd = options.cwd || process.cwd();
    const pluginId = options.pluginId;
    const timeoutMs = options.timeoutMs || 4_000;
    if (!pluginId) {
      resolve({
        status: "unsupported",
        detail: "Nuanu Flow plugin id is unavailable",
        hooks: [],
      });
      return;
    }

    let settled = false;
    let stderr = "";
    let nextId = 1;
    const pending = new Map();
    const child = spawn(codexBin, ["app-server", "--stdio"], {
      cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = readline.createInterface({ input: child.stdout });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.close();
      pending.clear();
      if (!child.killed) child.kill("SIGTERM");
      resolve(result);
    };
    const unsupported = (detail) =>
      finish({
        status: "unsupported",
        detail,
        hooks: [],
      });
    const write = (message) => {
      if (settled || child.stdin.destroyed) return;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
      );
    };
    const request = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, {
          method,
          resolve: resolveRequest,
          reject: rejectRequest,
        });
        write({ id, method, params });
      });
    const timer = setTimeout(
      () => unsupported(`Codex hook status timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1_000) stderr += String(chunk);
    });
    child.on("error", (error) => {
      unsupported(`Codex hook status could not start: ${error.message}`);
    });
    child.on("close", (code) => {
      if (!settled) {
        const suffix = stderr.trim()
          ? `: ${stderr.trim().slice(0, 300)}`
          : "";
        unsupported(
          `Codex hook status exited before responding (${code})${suffix}`,
        );
      }
    });
    output.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (
        !Object.prototype.hasOwnProperty.call(message, "id") ||
        message.method
      ) {
        return;
      }
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) return;
      pending.delete(message.id);
      if (message.error) {
        pendingRequest.reject(
          new Error(
            message.error.message ||
              `Codex App Server rejected ${pendingRequest.method}`,
          ),
        );
      } else {
        pendingRequest.resolve(message.result);
      }
    });

    (async () => {
      try {
        await request("initialize", {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true },
        });
        write({ method: "initialized", params: {} });
        const result = await request("hooks/list", { cwds: [cwd] });
        finish(hookStatusFromRows(result?.data, pluginId));
      } catch (error) {
        unsupported(`Codex hook status is unavailable: ${error.message}`);
      }
    })();
  });
}
