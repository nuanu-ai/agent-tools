#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const codexBin = process.env.CODEX_BIN || "codex";

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body == null ? "" : JSON.stringify(body));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

async function startMcpFixture() {
  const marker = `same-thread-${Date.now()}`;
  const toolCalls = [];
  const server = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    if (req.method === "DELETE") return jsonResponse(res, 200, {});
    if (req.method !== "POST") {
      return jsonResponse(res, 405, { error: "method not allowed" });
    }
    if (body?.id == null) {
      res.writeHead(202);
      res.end();
      return;
    }

    let result;
    if (body.method === "initialize") {
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: {
          name: "nuanu-flow-hot-reload-acceptance",
          version: "1.0.0",
        },
      };
    } else if (body.method === "tools/list") {
      result = {
        tools: [
          {
            name: "flow_reload_identity",
            description:
              "Return proof that a Flow MCP tool was attached after this thread started.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ],
      };
    } else if (body.method === "tools/call") {
      assert.equal(body.params?.name, "flow_reload_identity");
      toolCalls.push(body.params);
      const identity = {
        attached: true,
        marker,
      };
      result = {
        content: [{ type: "text", text: JSON.stringify(identity) }],
        structuredContent: identity,
        isError: false,
      };
    } else if (body.method === "ping") {
      result = {};
    } else {
      return jsonResponse(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `unsupported method ${body.method}` },
      });
    }
    return jsonResponse(res, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result,
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    marker,
    toolCalls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

class AppServerClient {
  constructor({ codexHome }) {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.turnWaiters = new Map();
    this.agentOutput = "";
    this.stderr = "";
    this.child = spawn(codexBin, ["app-server"], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  write(message) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
    );
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { method, resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  onLine(line) {
    const message = JSON.parse(line);
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${pending.method}: ${
              message.error.message || JSON.stringify(message.error)
            }`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id != null && message.method) {
      this.write({
        id: message.id,
        result:
          message.method === "item/tool/requestUserInput"
            ? { answers: {} }
            : { decision: "decline" },
      });
      return;
    }

    this.notifications.push(message);
    if (message.method === "item/agentMessage/delta") {
      this.agentOutput += message.params?.delta || "";
    }
    if (
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage" &&
      typeof message.params.item.text === "string"
    ) {
      this.agentOutput = message.params.item.text;
    }
    if (message.method === "turn/completed") {
      const turn = message.params?.turn;
      const waiter = this.turnWaiters.get(turn?.id);
      if (waiter) {
        this.turnWaiters.delete(turn.id);
        waiter.resolve(turn);
      }
    }
  }

  waitForTurn(turnId, timeoutMs = 240000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(
          new Error(
            `turn ${turnId} timed out after ${timeoutMs}ms: ${this.stderr.slice(
              -2000,
            )}`,
          ),
        );
      }, timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: (turn) => {
          clearTimeout(timer);
          resolve(turn);
        },
      });
    });
  }

  async close() {
    this.lines.close();
    if (this.child.exitCode != null) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (this.child.exitCode == null) this.child.kill("SIGKILL");
  }
}

function addMcpServer(codexHome, url) {
  const result = spawnSync(
    codexBin,
    ["mcp", "add", "nuanu-flow", "--url", url],
    {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `codex mcp add failed (${result.status}): ${String(
        result.stderr || "",
      ).trim()}`,
    );
  }
}

function turnOutput(turn, streamedOutput = "") {
  const completed = (turn?.items || [])
    .filter((item) => item?.type === "agentMessage")
    .map((item) => item.text || "")
    .filter(Boolean)
    .join("\n");
  return completed || streamedOutput;
}

async function main() {
  const authenticatedHome =
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const authenticatedAuth = path.join(authenticatedHome, "auth.json");
  await fs.access(authenticatedAuth);

  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-codex-hot-reload-"),
  );
  const codexHome = path.join(temporary, "codex-home");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await fs.symlink(authenticatedAuth, path.join(codexHome, "auth.json"));

  const mcp = await startMcpFixture();
  const client = new AppServerClient({ codexHome });
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "nuanu-flow-hot-reload-acceptance",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    client.notify("initialized", {});

    const started = await client.request("thread/start", {
      cwd: repoRoot,
      approvalPolicy: "never",
      ephemeral: true,
      serviceName: "nuanu-flow-hot-reload-acceptance",
    });
    const threadId =
      started?.thread?.id || started?.threadId || started?.id || "";
    assert(threadId, "app-server must return a thread id");

    addMcpServer(codexHome, mcp.url);
    await client.request("config/mcpServer/reload", null);

    const turnStart = await client.request("turn/start", {
      threadId,
      cwd: repoRoot,
      approvalPolicy: "never",
      input: [
        {
          type: "text",
          text: "Call the MCP tool flow_reload_identity exactly once. Return only JSON with attached and marker from the tool response. Do not infer values or inspect files.",
        },
      ],
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          attached: { type: "boolean" },
          marker: { type: "string" },
        },
        required: ["attached", "marker"],
      },
    });
    const turnId =
      turnStart?.turn?.id || turnStart?.turnId || turnStart?.id || "";
    assert(turnId, "app-server must return a turn id");
    const turn = await client.waitForTurn(turnId);
    assert.equal(
      turn.status,
      "completed",
      `turn failed: ${JSON.stringify(turn.error || turn)}`,
    );
    assert.equal(
      mcp.toolCalls.length,
      1,
      `same thread did not call the reloaded MCP tool: ${turnOutput(
        turn,
        client.agentOutput,
      )}`,
    );
    assert.match(turnOutput(turn, client.agentOutput), new RegExp(mcp.marker));
    console.log(
      `same-thread reload passed: thread ${threadId} called Flow MCP marker ${mcp.marker}`,
    );
  } finally {
    await client.close();
    await mcp.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `[codex-hot-reload-acceptance] ${error.stack || error.message}`,
  );
  process.exit(1);
});
