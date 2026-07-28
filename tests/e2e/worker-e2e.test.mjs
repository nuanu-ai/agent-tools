import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  activityInternals,
} from "../../plugins/nuanu-flow/scripts/activity/remote-worker-activity.mjs";

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
      method: "item/started",
      params: {
        threadId: "thread-test",
        turnId: "turn-test",
        item: {
          id: "command-test",
          type: "commandExecution",
          command: "must not enter activity",
        },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-test",
        turnId: "turn-test",
        item: {
          id: "command-test",
          type: "commandExecution",
          command: "must not enter activity",
        },
      },
    });
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

async function makeFakeClaude(tmpDir) {
  const fakeClaude = path.join(tmpDir, "claude");
  await fs.writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (!args.includes("-p")) process.exit(21);
  if (!args.includes("stream-json")) process.exit(22);
  if (!args.includes("--verbose")) process.exit(23);
  if (!args.includes("dontAsk")) process.exit(24);
  if (!args.includes("mcp__plugin_nuanu-flow_mcp__*")) process.exit(25);
  if (process.env.NUANU_AGENT_KEY !== "per-task-key") process.exit(26);
  if (process.env.NUANU_TOKEN || process.env.NUANU_DEV_TOKEN) process.exit(27);
  if (!input.includes("Task for claude-code")) process.exit(28);
  process.stdout.write(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "claude-session-test",
    plugins: [{ name: "nuanu-flow" }]
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "claude-code result",
    session_id: "claude-session-test"
  }) + "\\n");
});
`,
    "utf8"
  );
  await fs.chmod(fakeClaude, 0o755);
  return fakeClaude;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function waitFor(check, ms, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out after ${ms}ms`);
}

async function readActivityEvents(activityDirectory, sessionId) {
  const eventDirectory = path.join(
    activityInternals.sessionDirectory(activityDirectory, sessionId),
    "events",
  );
  try {
    const names = (await fs.readdir(eventDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    return Promise.all(
      names.map(async (name) =>
        JSON.parse(await fs.readFile(path.join(eventDirectory, name), "utf8")),
      ),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
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
  const fakeClaude = await makeFakeClaude(tmpDir);
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
  const ownerSessionId = `session-worker-${adapter}`;
  const activityDirectory = path.join(tmpDir, "activity");
  const child = spawn(process.execPath, [workerScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NUANU_URL: server.baseUrl,
      NUANU_AGENT_KEY: "worker-key",
      NUANU_ADAPTER: adapter,
      NUANU_CODEX_BIN: fakeCodex,
      NUANU_CODEX_CWD: tmpDir,
      NUANU_CLAUDE_BIN: fakeClaude,
      NUANU_CLAUDE_CWD: tmpDir,
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
      CODEX_THREAD_ID: ownerSessionId,
      NUANU_ACTIVITY_DATA_DIR: activityDirectory,
      NUANU_AGENT_NAME: "Codex Worker",
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
    assert.match(stdout, /session_activity=attached/);
    assert.match(stdout, /▶ Claimed “Codex step”/);
    const activityEvents = await waitFor(async () => {
      const events = await readActivityEvents(
        activityDirectory,
        ownerSessionId,
      );
      return events.some((event) => event.kind === "task.completed")
        ? events
        : null;
    }, 5000, `${adapter} activity completion`);
    const serializedActivity = JSON.stringify(activityEvents);
    assert.doesNotMatch(serializedActivity, /per-task-key/);
    assert.doesNotMatch(
      serializedActivity,
      new RegExp(`Task for ${adapter}`),
    );
    assert(
      activityEvents.every(
        (event) => event.owner_session_id === ownerSessionId,
      ),
    );
    assert.equal(stderr, "");
    return { result, stdout, activityEvents };
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
  const { result, stdout, activityEvents } =
    await runWorkerE2E("codex-app-server");
  assert.equal(result.body.output, "app-server result");
  assert.match(stdout, /adapter=codex-app-server/);
  assert.match(stdout, /├ Running a command/);
  assert.match(stdout, /! Needs attention/);
  assert.match(stdout, /✓ Completed “Codex step”/);
  assert(activityEvents.some((event) => event.kind === "task.progress"));
  assert(activityEvents.some((event) => event.kind === "task.attention"));
});

test("worker completes a task through first-class Claude Code streaming mode", async () => {
  const { result, stdout } = await runWorkerE2E("claude-code");
  assert.equal(result.body.output, "claude-code result");
  assert.match(stdout, /adapter=claude-code/);
});

test("bundled enrollment exchanges once, stores privately, and feeds worker config", async () => {
  const [{ enroll, normalizeApiBase }, { createFileCredentialStore }, { loadConfig }] = await Promise.all([
    import("../../plugins/nuanu-flow/scripts/worker/enroll.mjs"),
    import("../../plugins/nuanu-flow/scripts/worker/credentials.mjs"),
    import("../../plugins/nuanu-flow/scripts/worker/config.mjs"),
  ]);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-public-enroll-"));
  const credentialPath = path.join(tmpDir, "credentials", "worker.json");
  const credentialStore = createFileCredentialStore({ filePath: credentialPath });
  const enrollmentToken = `nuanu_join_${"ab".repeat(32)}`;
  const agentKey = `nuanu_flow_${"cd".repeat(32)}`;
  const agent = {
    id: "24d91802-8f82-43ef-8978-d69dc612ad47",
    display_name: "Codex Worker",
    workspace: "nuanu",
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/agent-worker/enroll/")) {
      return new Response(
        JSON.stringify({
          agent_key: agentKey,
          api_url: "https://flow.nuanu.com/api",
          agent,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        agent_id: agent.id,
        display_name: agent.display_name,
        workspace: agent.workspace,
        is_active: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const first = await enroll({
      enrollmentToken,
      credentialStore,
      fetchImpl,
    });
    const second = await enroll({
      enrollmentToken,
      credentialStore,
      fetchImpl,
    });
    const config = loadConfig({ env: {}, credentialStore });
    const storedStat = await fs.stat(credentialPath);
    const stored = JSON.parse(await fs.readFile(credentialPath, "utf8"));

    assert.deepEqual(first, { status: "enrolled", agent });
    assert.deepEqual(second, { status: "already_enrolled", agent });
    assert.equal(calls.filter(({ url }) => url.endsWith("/agent-worker/enroll/")).length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      enrollment_token: enrollmentToken,
    });
    assert.equal(calls[0].url.includes(enrollmentToken), false);
    assert.equal(JSON.stringify(first).includes(agentKey), false);
    assert.equal(storedStat.mode & 0o777, 0o600);
    assert.match(stored.enrollment_token_sha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(stored).includes(enrollmentToken), false);
    assert.equal(config.baseUrl, "https://flow.nuanu.com/api");
    assert.equal(config.agentKey, agentKey);
    assert.equal(normalizeApiBase("http://localhost:8000/api"), "http://localhost:8000/api");
    assert.throws(() => normalizeApiBase("http://flow.nuanu.com/api"), /HTTPS/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
