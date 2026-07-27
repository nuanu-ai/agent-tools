#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDevPackage } from "../../scripts/codex/dev-package.mjs";
import {
  REPO_ROOT,
  codexModeHome,
  runCodex,
} from "../../scripts/codex/modes.mjs";
import { buildCodexLaunch } from "../../scripts/codex/run-mode.mjs";
import {
  ensureSharedCodexAuth,
  setup,
  writeModeMcpConfig,
} from "../../scripts/codex/setup.mjs";

const repoRoot = REPO_ROOT;
const codexBin = process.env.CODEX_BIN || "codex";
const workerLauncherScript = path.join(
  repoRoot,
  "scripts/codex/run-worker.mjs",
);

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  res.end(body == null ? "" : JSON.stringify(body));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

async function startMcpFixture() {
  const nonce = randomUUID();
  const requests = [];
  const toolCalls = [];
  const server = http.createServer(async (req, res) => {
    let body = null;
    try {
      body = await readJsonBody(req);
    } catch {
      return jsonResponse(res, 400, { error: "invalid JSON" });
    }
    requests.push({
      method: req.method,
      url: req.url,
      body,
      userToken: req.headers["x-plane-user-token"] || "",
      agentKey: req.headers["x-agent-key"] || "",
      workspace: req.headers["x-plane-workspace"] || "",
    });

    if (req.method === "GET" && req.url === "/mcp") {
      return jsonResponse(res, 405, { error: "SSE stream not available" });
    }
    if (req.method === "GET") {
      return jsonResponse(res, 404, { error: "not found" });
    }
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
          name: "nuanu-flow-development-acceptance",
          version: "1.0.0",
        },
      };
    } else if (body.method === "tools/list") {
      result = {
        tools: [
          {
            name: "flow_dev_identity",
            description:
              "Return the fixed local development identity for acceptance testing.",
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
      if (body.params?.name !== "flow_dev_identity") {
        return jsonResponse(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unknown tool" },
        });
      }
      const identity = {
        environment: "LOCAL DEVELOPMENT",
        authenticated: Boolean(
          req.headers["x-plane-user-token"] || req.headers["x-agent-key"],
        ),
        nonce,
      };
      toolCalls.push({
        ...identity,
        userToken: req.headers["x-plane-user-token"] || "",
        agentKey: req.headers["x-agent-key"] || "",
      });
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
    requests,
    toolCalls,
    nonce,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startWorkerFixture(task) {
  let fetched = false;
  const requests = [];
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const server = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      body,
      agentKey: req.headers["x-agent-key"] || "",
    });
    if (req.method !== "POST") {
      return jsonResponse(res, 405, { error: "method not allowed" });
    }
    if (req.url === "/agent-worker/heartbeat/") {
      return jsonResponse(res, 200, { status: "ok" });
    }
    if (req.url === "/agent-worker/tasks/fetch-and-lock/") {
      if (fetched) return jsonResponse(res, 200, { tasks: [] });
      fetched = true;
      return jsonResponse(res, 200, { tasks: [task] });
    }
    const complete = req.url.match(
      /^\/agent-worker\/tasks\/([^/]+)\/complete\/$/,
    );
    if (complete) {
      resolveCompleted({
        taskId: complete[1],
        body,
        requests,
      });
      return jsonResponse(res, 200, { status: "ok" });
    }
    const fail = req.url.match(/^\/agent-worker\/tasks\/([^/]+)\/fail\/$/);
    if (fail) {
      rejectCompleted(
        new Error(`worker failed: ${JSON.stringify(body)}`),
      );
      return jsonResponse(res, 200, { status: "ok" });
    }
    return jsonResponse(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    completed,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function actualCodex(args, { codexHome, env = {}, cwd = repoRoot } = {}) {
  return runCodex(args, {
    codexBin,
    cwd,
    env: {
      ...process.env,
      ...env,
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    },
  });
}

function parseJsonOutput(label, output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function assertDevelopmentOnly(value, label) {
  assert.doesNotMatch(
    typeof value === "string" ? value : JSON.stringify(value),
    /flow\.nuanu\.com/,
    `${label} must not contain flow.nuanu.com`,
  );
}

async function assertPackagedSessionHook(pluginRoot, label) {
  const manifest = parseJsonOutput(
    `${label} manifest`,
    await fs.readFile(
      path.join(pluginRoot, ".codex-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  const hookConfig = parseJsonOutput(
    `${label} hook config`,
    await fs.readFile(path.join(pluginRoot, manifest.hooks), "utf8"),
  );
  const group = hookConfig.hooks?.SessionStart?.[0];
  const handler = group?.hooks?.[0];
  assert.equal(group?.matcher, "startup|resume|clear|compact");
  assert.equal(handler?.timeout, 1);
  assert.match(handler?.command || "", /session-start\.mjs/);
  const scriptPath = path.join(pluginRoot, "hooks/session-start.mjs");
  const durations = [];
  for (const source of ["startup", "resume", "clear", "compact"]) {
    for (let iteration = 0; iteration < 4; iteration++) {
      const started = performance.now();
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf8",
        input: JSON.stringify({
          session_id: "acceptance-session",
          transcript_path: null,
          cwd: repoRoot,
          hook_event_name: "SessionStart",
          model: "acceptance",
          permission_mode: "default",
          source,
          credential_probe: "MUST_NOT_APPEAR",
        }),
      });
      durations.push(performance.now() - started);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /MUST_NOT_APPEAR/);
      const output = parseJsonOutput(`${label} ${source} hook`, result.stdout);
      const context =
        output.hookSpecificOutput?.additionalContext || "";
      assert.match(context, /Nuanu Flow/);
      assert.match(context, /onboarding_next/);
      assert(
        context.trim().split(/\s+/).length <= 80,
        `${label} ${source} hook context exceeds 80 words`,
      );
    }
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert(
    p95 < 100,
    `${label} SessionStart hook p95 ${p95.toFixed(1)}ms exceeds 100ms`,
  );
  return p95;
}

async function installIsolatedModes({ codexHome, buildRoot, mcpUrl }) {
  const env = { NUANU_DEV_MCP_URL: mcpUrl };
  const dryRun = await setup({
    repoRoot,
    codexHome,
    buildRoot: path.join(path.dirname(buildRoot), "setup-preview"),
    codexBin,
    env,
    dryRun: true,
  });
  assert.deepEqual(
    dryRun.actions
      .filter((action) => action.kind === "plugin-add")
      .map((action) => action.args[2]),
    ["nuanu-flow@nuanu", "nuanu-flow-dev@nuanu-dev"],
  );

  const build = await buildDevPackage({
    buildRoot,
    env,
  });
  const homes = {
    prod: codexModeHome("prod", { codexHome }),
    dev: codexModeHome("dev", { codexHome }),
  };
  await fs.mkdir(homes.prod, { recursive: true, mode: 0o700 });
  await fs.mkdir(homes.dev, { recursive: true, mode: 0o700 });
  actualCodex(["plugin", "marketplace", "add", repoRoot, "--json"], {
    codexHome: homes.prod,
  });
  actualCodex(["plugin", "add", "nuanu-flow@nuanu", "--json"], {
    codexHome: homes.prod,
  });
  await writeModeMcpConfig("prod", homes.prod, env);
  actualCodex(
    ["plugin", "marketplace", "add", build.marketplaceRoot, "--json"],
    { codexHome: homes.dev },
  );
  actualCodex(["plugin", "add", "nuanu-flow-dev@nuanu-dev", "--json"], {
    codexHome: homes.dev,
  });
  await writeModeMcpConfig("dev", homes.dev, env);
  return { build, homes };
}

async function runCredentialFreeAcceptance(mcp) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-codex-acceptance-"),
  );
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  try {
    const installed = await installIsolatedModes({
      codexHome,
      buildRoot,
      mcpUrl: mcp.url,
    });
    const prodMcp = parseJsonOutput(
      "production mcp list",
      actualCodex(["mcp", "list", "--json"], {
        codexHome: installed.homes.prod,
      }).stdout,
    );
    const devMcp = parseJsonOutput(
      "development mcp list",
      actualCodex(["mcp", "list", "--json"], {
        codexHome: installed.homes.dev,
      }).stdout,
    );
    const prodPlugins = parseJsonOutput(
      "production plugin list",
      actualCodex(["plugin", "list", "--available", "--json"], {
        codexHome: installed.homes.prod,
      }).stdout,
    );
    const devPlugins = parseJsonOutput(
      "development plugin list",
      actualCodex(["plugin", "list", "--available", "--json"], {
        codexHome: installed.homes.dev,
      }).stdout,
    );

    assert.deepEqual(
      prodMcp.filter((server) => server.name === "nuanu-flow").map((server) => ({
        name: server.name,
        url: server.transport.url,
      })),
      [
        {
          name: "nuanu-flow",
          url: "https://flow.nuanu.com/mcp-server/mcp",
        },
      ],
    );
    assert.deepEqual(
      devMcp.filter((server) => server.name === "nuanu-flow").map((server) => ({
        name: server.name,
        url: server.transport.url,
      })),
      [{ name: "nuanu-flow", url: mcp.url }],
    );
    assertDevelopmentOnly(devMcp, "isolated development MCP list");
    assert.deepEqual(
      prodPlugins.installed
        .filter((plugin) => plugin.pluginId.includes("nuanu-flow"))
        .map((plugin) => plugin.pluginId),
      ["nuanu-flow@nuanu"],
    );
    assert.deepEqual(
      devPlugins.installed
        .filter((plugin) => plugin.pluginId.includes("nuanu-flow"))
        .map((plugin) => plugin.pluginId),
      ["nuanu-flow-dev@nuanu-dev"],
    );
    const productionRoot = path.join(repoRoot, "plugins/nuanu-flow");
    const productionManifest = parseJsonOutput(
      "production package manifest",
      await fs.readFile(
        path.join(productionRoot, ".codex-plugin/plugin.json"),
        "utf8",
      ),
    );
    assert.doesNotMatch(
      productionManifest.mcpServers["nuanu-flow"].url,
      /localhost|127\.0\.0\.1|\[::1\]/,
    );
    const productionP95 = await assertPackagedSessionHook(
      productionRoot,
      "production",
    );
    const developmentP95 = await assertPackagedSessionHook(
      installed.build.pluginRoot,
      "development",
    );
    console.log(
      `credential-free: real Codex installed both modes; SessionStart hooks passed (prod p95=${productionP95.toFixed(1)}ms, dev p95=${developmentP95.toFixed(1)}ms)`,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runModelExec({
  codexHome,
  env,
  schemaPath,
  outputPath,
  prompt,
}) {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    prompt,
  ];
  const child = spawn(codexBin, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      CODEX_HOME: codexHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 240000);
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  }).finally(() => clearTimeout(timer));

  if (timedOut) {
    throw new Error(`codex exec timed out after 240000ms: ${stderr.slice(-2000)}`);
  }
  if (code !== 0) {
    throw new Error(
      `codex exec exited ${code ?? signal}: ${stderr.slice(-2000)}`,
    );
  }
  return { status: code, signal, stdout, stderr };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await withTimeout(
    new Promise((resolve) => child.once("exit", resolve)),
    10000,
    "worker shutdown",
  );
}

async function runRealWorker({
  codexHome,
  buildEnv,
  mcp,
  tempRoot,
}) {
  const task = {
    task_id: "codex-app-server-acceptance",
    step_id: "step-1",
    step_name: "Real Codex App Server",
    instruction:
      "Use tool_search to load flow_dev_identity, then call it exactly once. Return only JSON with environment, authenticated, and nonce from the tool response.",
    context: { acceptance: true },
    output_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        environment: { type: "string" },
        authenticated: { type: "boolean" },
        nonce: { type: "string" },
      },
      required: ["environment", "authenticated", "nonce"],
    },
    system_prompt:
      "You are running the Nuanu Flow Codex App Server acceptance test.",
    agent_key: "per-task-acceptance-key",
  };
  const worker = await startWorkerFixture(task);
  const child = spawn(
    process.execPath,
    [
      workerLauncherScript,
      "dev",
      "--cwd",
      repoRoot,
      "--codex-bin",
      codexBin,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...buildEnv,
        CODEX_HOME: codexHome,
        NUANU_URL: worker.baseUrl,
        NUANU_DEV_URL: worker.baseUrl,
        NUANU_DEV_AGENT_KEY: "durable-acceptance-worker-key",
        NUANU_ADAPTER: "codex-app-server",
        NUANU_POLL_INTERVAL_MS: "500",
        NUANU_HEARTBEAT_INTERVAL_MS: "5000",
        NUANU_ADAPTER_TIMEOUT_MS: "240000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const completed = await withTimeout(
      worker.completed,
      300000,
      "real App Server worker",
    );
    assert.equal(completed.body.status, "ok");
    assert.match(String(completed.body.output), /LOCAL DEVELOPMENT/);
    assert.match(String(completed.body.output), new RegExp(mcp.nonce));
    assert(
      completed.requests
        .filter((request) => request.method === "POST")
        .every(
          (request) =>
            request.agentKey === "durable-acceptance-worker-key",
        ),
    );
    assert.match(stdout, /adapter=codex-app-server/);
    assert.equal(stderr, "");
    const taskCall = mcp.toolCalls.find(
      (call) => call.agentKey === "per-task-acceptance-key",
    );
    assert(taskCall, "real App Server MCP call must use the per-task key");
    assert.equal(
      taskCall.userToken,
      "",
      "real App Server MCP call must not inherit the interactive user token",
    );
  } catch (error) {
    error.message +=
      `\nWrapper stdout:\n${stdout.slice(-5000)}` +
      `\nWrapper stderr:\n${stderr.slice(-5000)}` +
      `\nWorker requests:\n${JSON.stringify(worker.requests)}` +
      `\nMCP calls:\n${JSON.stringify(mcp.toolCalls)}`;
    throw error;
  } finally {
    await stopChild(child);
    await worker.close();
    await fs.rm(path.join(tempRoot, "worker-output"), {
      recursive: true,
      force: true,
    });
  }
}

async function runModelBackedAcceptance(mcp, options = {}) {
  const authenticatedHome =
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-codex-model-acceptance-"),
  );
  const codexHome = path.join(tempRoot, "codex-home");
  const prodHome = codexModeHome("prod", { codexHome });
  const devHome = codexModeHome("dev", { codexHome });
  const sourceRoot = path.join(tempRoot, "plugin-source");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const schemaPath = path.join(tempRoot, "identity-schema.json");
  const outputPath = path.join(tempRoot, "model-output.json");
  const markerSchemaPath = path.join(tempRoot, "marker-schema.json");
  const markerOutputPath = path.join(tempRoot, "marker-output.json");
  const buildEnv = {
    NUANU_DEV_MCP_URL: mcp.url,
    NUANU_DEV_TOKEN: "acceptance-development-token",
    NUANU_DEV_WORKSPACE: "acceptance-local",
  };
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const authenticatedAuth = path.join(authenticatedHome, "auth.json");
  await fs.access(authenticatedAuth);
  await fs.symlink(authenticatedAuth, path.join(codexHome, "auth.json"));
  await ensureSharedCodexAuth(codexHome, prodHome);
  await ensureSharedCodexAuth(codexHome, devHome);
  await fs.cp(
    path.join(repoRoot, "plugins/nuanu-flow"),
    sourceRoot,
    { recursive: true },
  );
  await fs.writeFile(
    schemaPath,
    `${JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          environment: {
            type: "string",
          },
          authenticated: { type: "boolean" },
          nonce: { type: "string" },
        },
        required: ["environment", "authenticated", "nonce"],
      },
      null,
      2,
    )}\n`,
  );

  try {
    const firstBuild = await buildDevPackage({
      pluginRoot: sourceRoot,
      buildRoot,
      env: buildEnv,
    });
    actualCodex(["plugin", "marketplace", "add", repoRoot, "--json"], {
      codexHome: prodHome,
    });
    actualCodex(["plugin", "add", "nuanu-flow@nuanu", "--json"], {
      codexHome: prodHome,
    });
    await writeModeMcpConfig("prod", prodHome, buildEnv);
    actualCodex(
      ["plugin", "marketplace", "add", buildRoot, "--json"],
      { codexHome: devHome },
    );
    actualCodex(
      ["plugin", "add", "nuanu-flow-dev@nuanu-dev", "--json"],
      { codexHome: devHome },
    );
    await writeModeMcpConfig("dev", devHome, buildEnv);

    const prodBefore = actualCodex(
      ["mcp", "list", "--json"],
      { codexHome: prodHome },
    ).stdout;
    const pluginsBefore = parseJsonOutput(
      "plugins before model acceptance",
      actualCodex(["plugin", "list", "--available", "--json"], {
        codexHome: prodHome,
      }).stdout,
    );
    const prodVersionBefore = pluginsBefore.installed.find(
      (plugin) => plugin.pluginId === "nuanu-flow@nuanu",
    )?.version;
    const devMcp = actualCodex(
      ["mcp", "list", "--json"],
      { codexHome: devHome, env: buildEnv },
    ).stdout;
    assertDevelopmentOnly(devMcp, "model development MCP list");
    const launch = await buildCodexLaunch("dev", {
      codexHome,
      env: buildEnv,
      codexArgs: ["exec", "--ephemeral"],
    });
    assertDevelopmentOnly(
      {
        args: launch.args,
        banner: launch.banner,
        nuanuEnv: Object.fromEntries(
          Object.entries(launch.env).filter(([key]) =>
            key.startsWith("NUANU"),
          ),
        ),
      },
      "development launch plan",
    );

    if (options.workerOnly) {
      await runRealWorker({
        codexHome,
        buildEnv,
        mcp,
        tempRoot,
      });
      console.log("model-backed: App Server worker wrapper passed");
      return;
    }

    const prompt =
      "Use tool_search to find and load the flow_dev_identity MCP tool. Then call it exactly once and return its environment, authenticated, and nonce fields. Do not infer any value or inspect files.";
    const firstExec = await runModelExec({
      codexHome: devHome,
      env: buildEnv,
      schemaPath,
      outputPath,
      prompt,
    });
    const firstOutput = parseJsonOutput(
      "first model output",
      await fs.readFile(outputPath, "utf8"),
    );
    assert.deepEqual(
      firstOutput,
      {
        environment: "LOCAL DEVELOPMENT",
        authenticated: true,
        nonce: mcp.nonce,
      },
      `Codex MCP diagnostics: ${String(firstExec.stderr)
        .split("\n")
        .filter((line) => /mcp|rmcp|nuanu-flow/i.test(line))
        .slice(0, 120)
        .join("\n")}\nMCP requests: ${JSON.stringify(mcp.requests)}`,
    );
    assert(
      mcp.toolCalls.some(
        (call) => call.userToken === "acceptance-development-token",
      ),
      `model MCP call must present the development token: ${JSON.stringify(
        mcp.toolCalls,
      )}`,
    );

    await runModelExec({
      codexHome: devHome,
      env: buildEnv,
      schemaPath,
      outputPath,
      prompt,
    });
    const secondOutput = parseJsonOutput(
      "second model output",
      await fs.readFile(outputPath, "utf8"),
    );
    assert.deepEqual(secondOutput, firstOutput);

    const marker = `ACCEPTANCE_MARKER_codex_dev_refresh_${Date.now()}`;
    await fs.appendFile(
      path.join(sourceRoot, "skills/codex-setup/SKILL.md"),
      `\nAcceptance-only instruction: when asked for the acceptance marker, return exactly ${marker}.\n`,
    );
    const refreshed = await buildDevPackage({
      pluginRoot: sourceRoot,
      buildRoot,
      env: buildEnv,
    });
    assert.equal(refreshed.changed, true);
    assert.notEqual(refreshed.fingerprint, firstBuild.fingerprint);
    assert.notEqual(refreshed.version, firstBuild.version);
    actualCodex(
      ["plugin", "add", "nuanu-flow-dev@nuanu-dev", "--json"],
      { codexHome: devHome },
    );
    await fs.writeFile(
      markerSchemaPath,
      `${JSON.stringify(
        {
          type: "object",
          additionalProperties: false,
          properties: {
            marker: { type: "string" },
          },
          required: ["marker"],
        },
        null,
        2,
      )}\n`,
    );
    await runModelExec({
      codexHome: devHome,
      env: buildEnv,
      schemaPath: markerSchemaPath,
      outputPath: markerOutputPath,
      prompt:
        "Use the nuanu-flow-dev:codex-setup skill. Return the acceptance marker specified by that skill.",
    });
    assert.deepEqual(
      parseJsonOutput(
        "skill refresh model output",
        await fs.readFile(markerOutputPath, "utf8"),
      ),
      { marker },
    );

    await runRealWorker({
      codexHome,
      buildEnv,
      mcp,
      tempRoot,
    });

    const prodAfter = actualCodex(
      ["mcp", "list", "--json"],
      { codexHome: prodHome },
    ).stdout;
    const pluginsAfter = parseJsonOutput(
      "plugins after model acceptance",
      actualCodex(["plugin", "list", "--available", "--json"], {
        codexHome: prodHome,
      }).stdout,
    );
    const prodVersionAfter = pluginsAfter.installed.find(
      (plugin) => plugin.pluginId === "nuanu-flow@nuanu",
    )?.version;
    assert.deepEqual(
      parseJsonOutput("production before", prodBefore),
      parseJsonOutput("production after", prodAfter),
    );
    assert.equal(prodVersionAfter, prodVersionBefore);
    console.log("model-backed: MCP, fresh sessions, skill refresh, and App Server worker passed");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const unknownArgs = process.argv
    .slice(2)
    .filter((arg) => arg !== "--model" && arg !== "--worker-only");
  if (unknownArgs.length) {
    throw new Error(`Unknown acceptance argument: ${unknownArgs[0]}`);
  }
  const version = actualCodex(["--version"]).stdout.trim();
  console.log(`acceptance Codex: ${version}`);
  const mcp = await startMcpFixture();
  try {
    await runCredentialFreeAcceptance(mcp);
    if (!process.argv.includes("--model")) {
      console.log(
        "model-backed: skipped (run npm run test:acceptance:codex:model)",
      );
      return;
    }
    await runModelBackedAcceptance(mcp, {
      workerOnly: process.argv.includes("--worker-only"),
    });
  } finally {
    await mcp.close();
  }
}

main().catch((error) => {
  console.error(`[codex-acceptance] ${error.stack || error.message}`);
  process.exit(1);
});
