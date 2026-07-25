import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerScript = path.join(repoRoot, "plugins/nuanu-flow/scripts/worker/worker.mjs");

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startNuanuServer(task) {
  let fetched = false;
  const requests = [];
  let resolveComplete;
  let rejectComplete;
  const completed = new Promise((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      body,
      agentKey: req.headers["x-agent-key"],
    });

    if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed" });

    if (req.url === "/agent-worker/heartbeat/") {
      return writeJson(res, 200, { status: "ok" });
    }

    if (req.url === "/agent-worker/tasks/fetch-and-lock/") {
      if (fetched) return writeJson(res, 200, { tasks: [] });
      fetched = true;
      return writeJson(res, 200, { tasks: [task] });
    }

    const completeMatch = req.url.match(/^\/agent-worker\/tasks\/([^/]+)\/complete\/$/);
    if (completeMatch) {
      resolveComplete({ taskId: completeMatch[1], body, requests });
      return writeJson(res, 200, { status: "ok" });
    }

    const failMatch = req.url.match(/^\/agent-worker\/tasks\/([^/]+)\/fail\/$/);
    if (failMatch) {
      rejectComplete(new Error(`worker failed task: ${JSON.stringify(body)}`));
      return writeJson(res, 200, { status: "ok" });
    }

    writeJson(res, 404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    completed,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function makeFakeCodex(tmpDir) {
  const fakeCodex = path.join(tmpDir, "codex");
  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";

const args = process.argv.slice(2);

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
}

if (args[0] === "exec") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", async () => {
    const outIndex = args.indexOf("--output-last-message");
    if (outIndex === -1) process.exit(2);
    await fs.writeFile(args[outIndex + 1], "codex-exec result for " + input.slice(0, 40));
    process.exit(0);
  });
} else if (args.includes("app-server")) {
  if (
    process.env.FAKE_EXPECT_CODEX_HOME &&
    process.env.CODEX_HOME !== process.env.FAKE_EXPECT_CODEX_HOME
  ) {
    process.exit(17);
  }
  const expected = new Map();
  let approvalsDone = 0;
  let completed = false;

  function request(method, params = {}) {
    const id = "server-" + (expected.size + 1);
    expected.set(id, method);
    send({ id, method, params });
  }

  function maybeComplete() {
    if (completed || approvalsDone < 5) return;
    completed = true;
    send({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-test", turnId: "turn-test", itemId: "agent-msg", delta: "app-server " }
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-test",
        turnId: "turn-test",
        completedAtMs: Date.now(),
        item: { id: "agent-msg", type: "agentMessage", text: "app-server result" }
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-test",
        turn: {
          id: "turn-test",
          status: "completed",
          items: [{ id: "agent-msg", type: "agentMessage", text: "app-server result" }]
        }
      }
    });
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (expected.has(msg.id) && !msg.method) {
      const method = expected.get(msg.id);
      expected.delete(msg.id);
      if (method === "item/commandExecution/requestApproval") {
        if (msg.result?.decision !== "decline") process.exit(11);
      } else if (method === "item/fileChange/requestApproval") {
        if (msg.result?.decision !== "decline") process.exit(12);
      } else if (method === "mcpServer/elicitation/request") {
        if (msg.result?.action !== "decline") process.exit(13);
      } else if (method === "item/tool/requestUserInput") {
        if (!msg.result?.answers) process.exit(14);
      } else if (method === "item/permissions/requestApproval") {
        if (!msg.error) process.exit(15);
      }
      approvalsDone++;
      maybeComplete();
      return;
    }

    if (msg.method === "initialize") {
      send({ id: msg.id, result: { protocolVersion: "2" } });
    } else if (msg.method === "initialized") {
      // notification
    } else if (msg.method === "thread/start") {
      send({
        id: msg.id,
        result: {
          thread: { id: "thread-test" },
          cwd: process.cwd(),
          model: "fake",
          modelProvider: "fake",
          sandbox: "read-only",
          approvalPolicy: "never",
          approvalsReviewer: "user"
        }
      });
    } else if (msg.method === "turn/start") {
      const text = msg.params?.input?.[0]?.text || "";
      if (!text.includes("Task for codex-app-server")) process.exit(16);
      if (
        process.env.FAKE_EXPECT_AGENT_KEY_ENV &&
        process.env[process.env.FAKE_EXPECT_AGENT_KEY_ENV] !== "per-task-key"
      ) {
        process.exit(19);
      }
      send({ id: msg.id, result: { turn: { id: "turn-test" } } });
      send({ method: "turn/started", params: { threadId: "thread-test", turn: { id: "turn-test" } } });
      request("item/commandExecution/requestApproval");
      request("item/fileChange/requestApproval");
      request("mcpServer/elicitation/request");
      request("item/tool/requestUserInput");
      request("item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
    }
  });
} else {
  process.stderr.write("unexpected fake codex args: " + args.join(" ") + "\\n");
  process.exit(2);
}
`,
    "utf8"
  );
  await fs.chmod(fakeCodex, 0o755);
  return fakeCodex;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function stopWorker(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await withTimeout(
    new Promise((resolve) => child.once("exit", resolve)),
    5000,
    "worker shutdown"
  );
}

async function runWorkerE2E(adapter) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `nuanu-worker-${adapter}-`));
  const fakeCodex = await makeFakeCodex(tmpDir);
  const task = {
    task_id: `task-${adapter}`,
    step_id: "step-1",
    step_name: "Codex step",
    instruction: `Task for ${adapter}: return a short success message.`,
    context: { adapter },
    output_schema: {
      type: "object",
      additionalProperties: true,
    },
    system_prompt: "You are a Nuanu Flow worker test agent.",
    agent_key: "per-task-key",
  };
  const server = await startNuanuServer(task);
  const child = spawn(process.execPath, [workerScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NUANU_URL: server.baseUrl,
      NUANU_AGENT_KEY: "worker-key",
      NUANU_ADAPTER: adapter,
      NUANU_CODEX_BIN: fakeCodex,
      NUANU_CODEX_CWD: tmpDir,
      ...(adapter === "codex-app-server"
        ? {
            NUANU_CODEX_APP_SERVER_ARGS:
              "app-server --stdio",
            NUANU_CODEX_AGENT_KEY_ENV: "NUANU_DEV_AGENT_KEY",
            CODEX_HOME: path.join(tmpDir, "codex-home", "dev"),
            FAKE_EXPECT_CODEX_HOME: path.join(tmpDir, "codex-home", "dev"),
            FAKE_EXPECT_AGENT_KEY_ENV: "NUANU_DEV_AGENT_KEY",
          }
        : {}),
      NUANU_POLL_INTERVAL_MS: "500",
      NUANU_HEARTBEAT_INTERVAL_MS: "5000",
      NUANU_ADAPTER_TIMEOUT_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const result = await withTimeout(server.completed, 15000, `${adapter} worker completion`);
    assert.equal(result.taskId, task.task_id);
    assert.equal(result.body.status, "ok");
    assert.equal(result.body.worker_id, result.requests.find((r) => r.url === "/agent-worker/heartbeat/").body.worker_id);
    assert(result.requests.every((r) => r.agentKey === "worker-key"));
    assert.match(stdout, /remote agent connected/);
    assert.equal(stderr, "");
    return { result, stdout };
  } finally {
    await stopWorker(child);
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test("worker completes a task through codex-exec", async () => {
  const { result } = await runWorkerE2E("codex-exec");
  assert.match(result.body.output, /codex-exec result/);
});

test("worker completes a task through codex-app-server and handles server requests", async () => {
  const { result, stdout } = await runWorkerE2E("codex-app-server");
  assert.equal(result.body.output, "app-server result");
  assert.match(stdout, /adapter=codex-app-server/);
});
