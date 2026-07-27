import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workerScript = path.join(
  repoRoot,
  "plugins/nuanu-flow/scripts/worker/portable-worker.mjs",
);
const enrollmentToken = `nuanu_join_${"ab".repeat(32)}`;
const durableKey = `nuanu_flow_${"cd".repeat(32)}`;
const taskKey = `nuanu_flow_${"ef".repeat(32)}`;

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startWorkerApi({ commandFails = false } = {}) {
  const calls = [];
  let taskClaimed = false;
  let finish;
  let fail;
  const terminal = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const task = {
    task_id: "portable-task",
    run_id: "portable-run",
    step_id: "portable-step",
    instruction: commandFails ? "FAIL portable task" : "Complete portable task",
    system_prompt: "You are the portable worker acceptance agent.",
    context: { source: "portable-worker-test" },
    agent_key: taskKey,
  };

  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    calls.push({
      method: request.method,
      path: request.url,
      body,
      agentKey: request.headers["x-agent-key"],
    });

    if (request.url === "/api/agent-worker/enroll/") {
      assert.equal(body.enrollment_token, enrollmentToken);
      return sendJson(response, 201, {
        agent_key: durableKey,
        api_url: `http://127.0.0.1:${server.address().port}/api`,
        agent: {
          id: "portable-agent",
          display_name: "Portable Agent",
          workspace: "portable-workspace",
        },
      });
    }
    if (request.url === "/api/agent-worker/whoami/") {
      return sendJson(response, 200, {
        agent_id: "portable-agent",
        display_name: "Portable Agent",
        workspace: "portable-workspace",
        is_active: true,
      });
    }
    if (request.url === "/api/agent-worker/heartbeat/") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.url === "/api/agent-worker/tasks/fetch-and-lock/") {
      if (taskClaimed) return sendJson(response, 200, { tasks: [] });
      taskClaimed = true;
      return sendJson(response, 200, { tasks: [task] });
    }
    if (request.url === "/api/agent-worker/tasks/portable-task/complete/") {
      finish({ kind: "complete", body, calls });
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.url === "/api/agent-worker/tasks/portable-task/fail/") {
      finish({ kind: "fail", body, calls });
      return sendJson(response, 200, { status: "ok" });
    }
    fail(new Error(`Unexpected request ${request.method} ${request.url}`));
    return sendJson(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}/api`,
    terminal,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runCli(args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function writeCommand(tmpDirectory, { fail = false } = {}) {
  const command = path.join(tmpDirectory, fail ? "fail-agent.mjs" : "agent.mjs");
  await fs.writeFile(
    command,
    `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  if (process.env.NUANU_AGENT_KEY !== ${JSON.stringify(taskKey)}) process.exit(31);
  if (process.env.NUANU_TOKEN || process.env.NUANU_DEV_TOKEN) process.exit(32);
  if (!input.includes("portable task")) process.exit(33);
  ${fail ? "process.stderr.write('intentional command failure\\n'); process.exit(7);" : "process.stdout.write('portable worker result');"}
});
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(command)}`;
}

test("portable worker enrolls through stdin, stores mode 0600, reports status, and completes a task", async () => {
  const tmpDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-portable-worker-"),
  );
  const credentialFile = path.join(tmpDirectory, "credentials", "worker.json");
  const api = await startWorkerApi();
  const command = await writeCommand(tmpDirectory);
  try {
    const enrolled = await runCli(
      [
        "enroll",
        "--base-url",
        api.apiBase,
        "--credential-file",
        credentialFile,
      ],
      { input: `${enrollmentToken}\n` },
    );
    assert.equal(enrolled.code, 0, enrolled.stderr);
    assert(!enrolled.stdout.includes(enrollmentToken));
    assert(!enrolled.stdout.includes(durableKey));
    assert.equal((await fs.stat(credentialFile)).mode & 0o777, 0o600);

    const status = await runCli([
      "status",
      "--base-url",
      api.apiBase,
      "--credential-file",
      credentialFile,
    ]);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), {
      status: "connected",
      environment: "local",
      agent: {
        id: "portable-agent",
        display_name: "Portable Agent",
        workspace: "portable-workspace",
      },
    });

    const run = await runCli([
      "run",
      "--base-url",
      api.apiBase,
      "--credential-file",
      credentialFile,
      "--command",
      command,
      "--once",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const terminal = await api.terminal;
    assert.equal(terminal.kind, "complete");
    assert.equal(terminal.body.output, "portable worker result");
    assert(
      terminal.calls
        .filter((call) => call.path !== "/api/agent-worker/enroll/")
        .every((call) => call.agentKey === durableKey),
    );
    assert(!run.stdout.includes(durableKey));
    assert(!run.stderr.includes(durableKey));
  } finally {
    await api.close();
    await fs.rm(tmpDirectory, { recursive: true, force: true });
  }
});

test("portable worker safely requeues a failed command without leaking credentials", async () => {
  const tmpDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-portable-worker-fail-"),
  );
  const credentialFile = path.join(tmpDirectory, "worker.json");
  const api = await startWorkerApi({ commandFails: true });
  const command = await writeCommand(tmpDirectory, { fail: true });
  try {
    const enrolled = await runCli(
      [
        "enroll",
        "--base-url",
        api.apiBase,
        "--credential-file",
        credentialFile,
      ],
      { input: enrollmentToken },
    );
    assert.equal(enrolled.code, 0, enrolled.stderr);

    const run = await runCli([
      "run",
      "--base-url",
      api.apiBase,
      "--credential-file",
      credentialFile,
      "--command",
      command,
      "--once",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const terminal = await api.terminal;
    assert.equal(terminal.kind, "fail");
    assert.equal(terminal.body.requeue, true);
    assert.match(terminal.body.error, /exited 7/);
    assert(!JSON.stringify(terminal.body).includes(durableKey));
    assert(!run.stdout.includes(durableKey));
    assert(!run.stderr.includes(durableKey));
  } finally {
    await api.close();
    await fs.rm(tmpDirectory, { recursive: true, force: true });
  }
});

test("portable worker rejects enrollment tokens passed as command arguments", async () => {
  const result = await runCli([
    "enroll",
    "--base-url",
    "https://flow.nuanu.com/api",
    enrollmentToken,
  ]);
  assert.notEqual(result.code, 0);
  assert(!result.stdout.includes(enrollmentToken));
  assert(!result.stderr.includes(enrollmentToken));
  assert.match(result.stderr, /Unknown option/);
});
