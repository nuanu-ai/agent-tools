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
import { installCurrentProfile } from "../../scripts/codex/install-current.mjs";
import {
  REPO_ROOT,
  codexModeHome,
  runCodex,
} from "../../scripts/codex/modes.mjs";
import { removeNuanuFlow } from "../../scripts/codex/remove.mjs";
import { buildCodexLaunch } from "../../scripts/codex/run-mode.mjs";
import {
  ensureSharedCodexAuth,
  setup,
  writeModeMcpConfig,
} from "../../scripts/codex/setup.mjs";
import {
  sessionActivityInternals,
} from "../../plugins/nuanu-flow-worker/scripts/worker/session_activity.mjs";

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
  const state = {
    available: true,
    onboarding: {
      complete: true,
      current_step: "complete",
    },
    gateWritesOnOnboarding: true,
  };
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

    if (!state.available) {
      return jsonResponse(res, 503, {
        error: "acceptance MCP temporarily unavailable",
      });
    }

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
          {
            name: "onboarding_next",
            description:
              "Return the authoritative onboarding status when the user explicitly requests it.",
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
          {
            name: "list_flow_items",
            description:
              "List the current user's Flow items. This is a read-only ordinary product operation and must not preflight onboarding.",
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
          {
            name: "create_flow_item",
            description:
              "Create a Flow item. If the server returns onboarding_required, call onboarding_next once for recovery instructions and do not retry this write automatically.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
              required: ["name"],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
        ],
      };
    } else if (body.method === "tools/call") {
      const toolName = body.params?.name;
      if (toolName === "onboarding_next") {
        const onboarding = { ...state.onboarding };
        toolCalls.push({ name: toolName });
        result = {
          content: [{ type: "text", text: JSON.stringify(onboarding) }],
          structuredContent: onboarding,
          isError: false,
        };
      } else if (toolName === "list_flow_items") {
        const listing = {
          count: 1,
          first_item: "Acceptance Flow item",
        };
        toolCalls.push({ name: toolName });
        result = {
          content: [{ type: "text", text: JSON.stringify(listing) }],
          structuredContent: listing,
          isError: false,
        };
      } else if (toolName === "create_flow_item") {
        toolCalls.push({
          name: toolName,
          input: body.params?.arguments || {},
        });
        if (state.gateWritesOnOnboarding) {
          const blocked = {
            code: "onboarding_required",
            message:
              "Finish the current Nuanu Flow onboarding step before creating a Flow item.",
            retryable: false,
            recovery: {
              tool: "onboarding_next",
            },
          };
          result = {
            content: [{ type: "text", text: JSON.stringify(blocked) }],
            structuredContent: blocked,
            isError: true,
          };
        } else {
          const created = { id: "acceptance-item", created: true };
          result = {
            content: [{ type: "text", text: JSON.stringify(created) }],
            structuredContent: created,
            isError: false,
          };
        }
      } else if (toolName === "flow_dev_identity") {
        const identity = {
          environment: "LOCAL DEVELOPMENT",
          authenticated: Boolean(
            req.headers["x-plane-user-token"] || req.headers["x-agent-key"],
          ),
          nonce,
        };
        toolCalls.push({
          name: toolName,
          ...identity,
          userToken: req.headers["x-plane-user-token"] || "",
          agentKey: req.headers["x-agent-key"] || "",
        });
        result = {
          content: [{ type: "text", text: JSON.stringify(identity) }],
          structuredContent: identity,
          isError: false,
        };
      } else {
        return jsonResponse(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unknown tool" },
        });
      }
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
    state,
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
    if (req.url.match(/^\/agent-worker\/tasks\/[^/]+\/(checkpoint|events|renew)\/$/)) {
      return jsonResponse(res, 200, { status: "ok" });
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

async function assertPackagedSessionHook(
  pluginRoot,
  workerPluginRoot,
  label,
) {
  const manifest = parseJsonOutput(
    `${label} manifest`,
    await fs.readFile(
      path.join(pluginRoot, ".codex-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.hooks, "./hooks/codex-hooks.json");
  const hookConfig = parseJsonOutput(
    `${label} hook config`,
    await fs.readFile(path.join(pluginRoot, manifest.hooks), "utf8"),
  );
  const group = hookConfig.hooks?.SessionStart?.[0];
  const handler = group?.hooks?.[0];
  assert.equal(group?.matcher, "startup|clear|compact");
  assert.equal(handler?.timeout, 1);
  assert.match(handler?.command || "", /session-start\.mjs/);
  assert.equal(hookConfig.hooks?.UserPromptSubmit, undefined);
  const workerManifest = parseJsonOutput(
    `${label} worker manifest`,
    await fs.readFile(
      path.join(workerPluginRoot, ".codex-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(workerManifest.mcpServers, undefined);
  const workerHookConfig = parseJsonOutput(
    `${label} worker hook config`,
    await fs.readFile(
      path.join(workerPluginRoot, workerManifest.hooks),
      "utf8",
    ),
  );
  const promptGroup = workerHookConfig.hooks?.UserPromptSubmit?.[0];
  const promptHandler = promptGroup?.hooks?.[0];
  assert.equal(workerHookConfig.hooks?.SessionStart, undefined);
  assert.equal(promptGroup?.matcher, undefined);
  assert.equal(promptHandler?.timeout, 1);
  assert.equal(promptHandler?.additionalContextLimit, 500);
  assert.match(
    promptHandler?.command || "",
    /user-prompt-submit\.mjs/,
  );
  await fs.access(
    path.join(workerPluginRoot, "hooks/user-prompt-submit.mjs"),
  );
  const scriptPath = path.join(pluginRoot, "hooks/session-start.mjs");
  const durations = [];
  const nodeStartupDurations = [];
  const bindingRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-hook-acceptance-"),
  );
  const unboundRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-hook-unbound-"),
  );
  try {
    await fs.mkdir(path.join(bindingRoot, ".git"));
    await fs.mkdir(path.join(unboundRoot, ".git"));
    await fs.writeFile(
      path.join(bindingRoot, ".nuanu-flow.json"),
      `${JSON.stringify({
        version: 1,
        workspace_slug: "acceptance",
        project_identifier: "HOOK",
      })}\n`,
    );
    for (const source of ["startup", "clear", "compact"]) {
      for (let iteration = 0; iteration < 4; iteration++) {
        const nodeStarted = performance.now();
        const nodeResult = spawnSync(process.execPath, ["-e", ""], {
          cwd: bindingRoot,
          encoding: "utf8",
        });
        nodeStartupDurations.push(performance.now() - nodeStarted);
        assert.equal(nodeResult.status, 0, nodeResult.stderr);
        const started = performance.now();
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: bindingRoot,
          encoding: "utf8",
          input: JSON.stringify({
            session_id: "acceptance-session",
            transcript_path: null,
            cwd: bindingRoot,
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
        const context = output.hookSpecificOutput?.additionalContext || "";
        assert.match(context, /Repository binding/);
        assert.match(context, /workspace "acceptance"/);
        assert.match(context, /project "HOOK"/);
        assert.doesNotMatch(
          context,
          /onboarding_next|onboarding|first actual turn/i,
        );
      }
    }

    for (const [source, cwd] of [
      ["resume", bindingRoot],
      ["startup", unboundRoot],
    ]) {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd,
        encoding: "utf8",
        input: JSON.stringify({
          session_id: "acceptance-session",
          transcript_path: null,
          cwd,
          hook_event_name: "SessionStart",
          source,
        }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
  } finally {
    await fs.rm(bindingRoot, { recursive: true, force: true });
    await fs.rm(unboundRoot, { recursive: true, force: true });
  }
  durations.sort((left, right) => left - right);
  nodeStartupDurations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  const p50 = durations[Math.ceil(durations.length * 0.5) - 1];
  const nodeStartupP95 =
    nodeStartupDurations[Math.ceil(nodeStartupDurations.length * 0.95) - 1];
  const nodeStartupP50 =
    nodeStartupDurations[Math.ceil(nodeStartupDurations.length * 0.5) - 1];
  assert(
    p95 < 750,
    `${label} SessionStart hook p95 ${p95.toFixed(1)}ms exceeds the 750ms safety ceiling`,
  );
  assert(
    p50 - nodeStartupP50 < 100,
    `${label} SessionStart hook adds ${(p50 - nodeStartupP50).toFixed(1)}ms at p50, exceeding the 100ms incremental budget`,
  );
  return { p50, p95, nodeStartupP50, nodeStartupP95 };
}

async function installIsolatedModes({ codexHome, buildRoot, mcpUrl }) {
  const env = {
    NUANU_DEV_MCP_URL: mcpUrl,
    NUANU_DEV_TOKEN: "acceptance-development-token",
  };
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
  const firstDevelopmentInstall = await installCurrentProfile("dev", {
    repoRoot,
    codexHome: homes.dev,
    buildRoot,
    codexBin,
    env,
  });
  await writeModeMcpConfig("dev", homes.dev, env);
  assert.equal(
    firstDevelopmentInstall.authStatus,
    "environment_credential",
  );
  assert(
    firstDevelopmentInstall.actions.some((action) =>
      action.includes("installed nuanu-flow-dev@nuanu-dev"),
    ),
    `first current-profile install must install the plugin: ${JSON.stringify(firstDevelopmentInstall.actions)}`,
  );
  const secondDevelopmentInstall = await installCurrentProfile("dev", {
    repoRoot,
    codexHome: homes.dev,
    buildRoot,
    codexBin,
    env,
  });
  assert.deepEqual(
    secondDevelopmentInstall.actions,
    [],
    "re-running the current-profile installer must be idempotent",
  );
  return {
    build: firstDevelopmentInstall.build,
    homes,
    env,
    firstDevelopmentInstall,
    secondDevelopmentInstall,
  };
}

async function installUnrelatedSentinel(codexHome, tempRoot) {
  const marketplaceRoot = path.join(tempRoot, "unrelated-marketplace");
  const pluginRoot = path.join(
    marketplaceRoot,
    "plugins",
    "acceptance-sentinel",
  );
  await fs.mkdir(path.join(marketplaceRoot, ".agents/plugins"), {
    recursive: true,
  });
  await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(marketplaceRoot, ".agents/plugins/marketplace.json"),
    `${JSON.stringify(
      {
        name: "acceptance-sentinel",
        plugins: [
          {
            name: "acceptance-sentinel",
            source: { source: "local", path: "./plugins/acceptance-sentinel" },
            policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginRoot, ".codex-plugin/plugin.json"),
    `${JSON.stringify(
      {
        name: "acceptance-sentinel",
        version: "1.0.0",
        description: "Unrelated plugin used to verify scoped removal.",
        author: { name: "Acceptance" },
        license: "MIT",
      },
      null,
      2,
    )}\n`,
  );
  actualCodex(
    ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
    { codexHome },
  );
  actualCodex(
    [
      "plugin",
      "add",
      "acceptance-sentinel@acceptance-sentinel",
      "--json",
    ],
    { codexHome },
  );
  return "acceptance-sentinel@acceptance-sentinel";
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
      "production mcp config",
      actualCodex(["mcp", "get", "nuanu-flow", "--json"], {
        codexHome: installed.homes.prod,
      }).stdout,
    );
    const devMcp = parseJsonOutput(
      "development mcp config",
      actualCodex(["mcp", "get", "nuanu-flow", "--json"], {
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
      { name: prodMcp.name, url: prodMcp.transport.url },
      {
        name: "nuanu-flow",
        url: "https://flow.nuanu.com/mcp-server/mcp",
      },
    );
    assert.deepEqual(
      { name: devMcp.name, url: devMcp.transport.url },
      { name: "nuanu-flow", url: mcp.url },
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
    const productionTiming = await assertPackagedSessionHook(
      productionRoot,
      path.join(repoRoot, "plugins/nuanu-flow-worker"),
      "production",
    );
    const developmentTiming = await assertPackagedSessionHook(
      installed.build.pluginRoot,
      installed.build.workerPluginRoot,
      "development",
    );
    const sentinelPluginId = await installUnrelatedSentinel(
      codexHome,
      tempRoot,
    );
    const basePluginsBeforeRemoval = parseJsonOutput(
      "base plugins before scoped removal",
      actualCodex(["plugin", "list", "--available", "--json"], {
        codexHome,
      }).stdout,
    );
    const unrelatedPluginIds = basePluginsBeforeRemoval.installed
      .map((plugin) => plugin.pluginId)
      .filter((pluginId) => !pluginId.includes("nuanu-flow"));
    assert(
      unrelatedPluginIds.includes(sentinelPluginId),
      "the base profile must retain the unrelated sentinel plugin for scoped-removal verification",
    );
    const removal = await removeNuanuFlow({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin,
      env: installed.env,
      keychain: { async remove() { return false; } },
    });
    assert(
      removal.actions.some(
        (action) =>
          action.kind === "command" &&
          action.args?.includes("nuanu-flow-dev@nuanu-dev"),
      ),
      "scoped removal must remove the installed development plugin",
    );
    await assert.rejects(fs.access(installed.homes.dev));
    const basePluginsAfterRemoval = parseJsonOutput(
      "base plugins after scoped removal",
      actualCodex(["plugin", "list", "--available", "--json"], {
        codexHome,
      }).stdout,
    );
    for (const pluginId of unrelatedPluginIds) {
      assert(
        basePluginsAfterRemoval.installed.some(
          (plugin) => plugin.pluginId === pluginId,
        ),
        `scoped removal must preserve unrelated plugin ${pluginId}`,
      );
    }
    console.log(
      `credential-free: real current-profile install was idempotent, scoped removal preserved unrelated plugins, and SessionStart hooks passed (prod p95=${productionTiming.p95.toFixed(1)}ms/node=${productionTiming.nodeStartupP95.toFixed(1)}ms, dev p95=${developmentTiming.p95.toFixed(1)}ms/node=${developmentTiming.nodeStartupP95.toFixed(1)}ms)`,
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
  autoApproveMcpWrites = false,
}) {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    ...(autoApproveMcpWrites
      ? [
          "--config",
          'mcp_servers.nuanu-flow.default_tools_approval_mode="auto"',
        ]
      : []),
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

async function waitForValue(check, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function readActivityRecords(activityDirectory, sessionId) {
  const eventDirectory = path.join(
    sessionActivityInternals.sessionDirectory(activityDirectory, sessionId),
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
  workerPluginRoot,
}) {
  const task = {
    task_id: "44444444-4444-4444-8444-444444444444",
    run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    step_id: "step-1",
    step_name: "Real Codex App Server",
    contract_version: "nuanu.agent-task.v1",
    request: {
      schema_version: "nuanu.agent-task.request.v1",
      instruction:
        "Use tool_search to load flow_dev_identity, then call it exactly once. Put its environment, authenticated, and nonce fields in item.data and return the exact required Process result JSON.",
      process: { step_key: "mcp_identity" },
      input: { acceptance: true },
      output_definition: {
        data: {
          environment: { type: "string" },
          authenticated: { type: "boolean" },
          nonce: { type: "string" },
        },
        artifacts: {},
      },
    },
    configuration_snapshot: {
      system_prompt:
        "You are running the Nuanu Flow Codex App Server acceptance test.",
    },
    workspace: "nuanu",
    agent_key: "per-task-acceptance-key",
    lease_token: "acceptance-lease-token",
    lease_generation: 1,
    attempt: 1,
    internal_mcp: {
      url: mcp.url,
      transport: "streamable_http",
      authentication: { type: "task_credential", header: "X-Agent-Key" },
      workspace_header: "X-Plane-Workspace",
    },
  };
  const worker = await startWorkerFixture(task);
  const ownerSessionId = "codex-remote-worker-acceptance-owner";
  const activityDirectory = path.join(tempRoot, "worker-activity");
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
        CODEX_THREAD_ID: ownerSessionId,
        NUANU_ACTIVITY_DATA_DIR: activityDirectory,
        NUANU_AGENT_NAME: "Acceptance Agent",
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
    assert.equal(completed.body.completion?.outcome, "success");
    assert.deepEqual(completed.body.completion.result.item.data, {
      environment: "LOCAL DEVELOPMENT",
      authenticated: true,
      nonce: mcp.nonce,
    });
    assert(
      completed.requests
        .filter((request) => request.method === "POST")
        .every(
          (request) =>
            request.agentKey === "durable-acceptance-worker-key",
        ),
    );
    assert.match(stdout, /adapter=codex-app-server/);
    assert.match(stdout, /session_activity=attached/);
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
    const activityRecords = await waitForValue(async () => {
      const records = await readActivityRecords(
        activityDirectory,
        ownerSessionId,
      );
      return records.some((event) => event.kind === "task.completed")
        ? records
        : null;
    }, 10_000, "real App Server activity completion");
    const serializedActivity = JSON.stringify(activityRecords);
    assert.doesNotMatch(serializedActivity, /flow_dev_identity/);
    assert.doesNotMatch(serializedActivity, /per-task-acceptance-key/);
    assert.doesNotMatch(serializedActivity, new RegExp(mcp.nonce));
    assert(
      activityRecords.some((event) => event.kind === "task.claimed"),
    );
    assert(
      activityRecords.some((event) => event.kind === "task.progress"),
    );
    assert(
      activityRecords.some((event) => event.kind === "task.completed"),
    );

    const hookScript = path.join(
      workerPluginRoot,
      "hooks/user-prompt-submit.mjs",
    );
    const hookPayload = (sessionId) =>
      JSON.stringify({
        session_id: sessionId,
        transcript_path: null,
        cwd: repoRoot,
        hook_event_name: "UserPromptSubmit",
        turn_id: "acceptance-turn",
        prompt: "Continue with my request",
        model: "acceptance",
        permission_mode: "default",
      });
    const hookOptions = {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NUANU_ACTIVITY_DATA_DIR: activityDirectory,
      },
    };
    let hook = spawnSync(
      process.execPath,
      [hookScript],
      {
        ...hookOptions,
        input: hookPayload("different-acceptance-session"),
      },
    );
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stdout, "");
    hook = spawnSync(
      process.execPath,
      [hookScript],
      {
        ...hookOptions,
        input: hookPayload(ownerSessionId),
      },
    );
    assert.equal(hook.status, 0, hook.stderr);
    const hookOutput = parseJsonOutput(
      "remote-worker activity hook",
      hook.stdout,
    );
    assert.match(
      hookOutput.hookSpecificOutput?.additionalContext || "",
      /Acceptance Agent completed “Real Codex App Server”/,
    );
    hook = spawnSync(
      process.execPath,
      [hookScript],
      {
        ...hookOptions,
        input: hookPayload(ownerSessionId),
      },
    );
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stdout, "");
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
  const onboardingSchemaPath = path.join(tempRoot, "onboarding-schema.json");
  const onboardingOutputPath = path.join(tempRoot, "onboarding-output.json");
  const listSchemaPath = path.join(tempRoot, "list-schema.json");
  const listOutputPath = path.join(tempRoot, "list-output.json");
  const recoverySchemaPath = path.join(tempRoot, "recovery-schema.json");
  const recoveryOutputPath = path.join(tempRoot, "recovery-output.json");
  const availabilitySchemaPath = path.join(
    tempRoot,
    "availability-schema.json",
  );
  const availabilityOutputPath = path.join(
    tempRoot,
    "availability-output.json",
  );
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
    actualCodex(
      ["plugin", "add", "nuanu-flow-worker-dev@nuanu-dev", "--json"],
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
        workerPluginRoot: firstBuild.workerPluginRoot,
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
    assert.equal(
      mcp.toolCalls.filter((call) => call.name === "onboarding_next").length,
      0,
      "ordinary fresh Codex sessions must not preflight onboarding",
    );

    await fs.writeFile(
      onboardingSchemaPath,
      `${JSON.stringify(
        {
          type: "object",
          additionalProperties: false,
          properties: {
            complete: { type: "boolean" },
            current_step: { type: "string" },
          },
          required: ["complete", "current_step"],
        },
        null,
        2,
      )}\n`,
    );
    await runModelExec({
      codexHome: devHome,
      env: buildEnv,
      schemaPath: onboardingSchemaPath,
      outputPath: onboardingOutputPath,
      prompt:
        "Explicitly check my Nuanu Flow onboarding status. Find and call onboarding_next exactly once, then return its complete and current_step fields.",
    });
    assert.deepEqual(
      parseJsonOutput(
        "explicit onboarding model output",
        await fs.readFile(onboardingOutputPath, "utf8"),
      ),
      { complete: true, current_step: "complete" },
    );
    assert.equal(
      mcp.toolCalls.filter((call) => call.name === "onboarding_next").length,
      1,
      "explicit onboarding intent must perform one authoritative status check",
    );
    if (options.sessionsOnly) {
      console.log(
        "model-backed: ordinary sessions skipped onboarding and explicit status checked exactly once",
      );
      return;
    }

    if (options.journey) {
      await fs.writeFile(
        listSchemaPath,
        `${JSON.stringify(
          {
            type: "object",
            additionalProperties: false,
            properties: {
              count: { type: "integer" },
              first_item: { type: "string" },
            },
            required: ["count", "first_item"],
          },
          null,
          2,
        )}\n`,
      );
      const onboardingCallsBeforeRead = mcp.toolCalls.filter(
        (call) => call.name === "onboarding_next",
      ).length;
      await runModelExec({
        codexHome: devHome,
        env: buildEnv,
        schemaPath: listSchemaPath,
        outputPath: listOutputPath,
        prompt:
          "List my Nuanu Flow items. Find and call list_flow_items exactly once, return its count and first_item fields, and do not check onboarding.",
      });
      assert.deepEqual(
        parseJsonOutput(
          "ordinary Flow usage output",
          await fs.readFile(listOutputPath, "utf8"),
        ),
        { count: 1, first_item: "Acceptance Flow item" },
      );
      assert.equal(
        mcp.toolCalls.filter((call) => call.name === "onboarding_next").length,
        onboardingCallsBeforeRead,
        "ordinary Flow usage must not preflight onboarding",
      );

      mcp.state.onboarding = {
        complete: false,
        current_step: "workspace",
      };
      const onboardingCallsBeforeIncomplete = mcp.toolCalls.filter(
        (call) => call.name === "onboarding_next",
      ).length;
      await runModelExec({
        codexHome: devHome,
        env: buildEnv,
        schemaPath: onboardingSchemaPath,
        outputPath: onboardingOutputPath,
        prompt:
          "Continue my Nuanu Flow first-run setup. Call onboarding_next exactly once and return only its complete and current_step fields. Do not invent or perform later setup steps.",
      });
      assert.deepEqual(
        parseJsonOutput(
          "incomplete onboarding model output",
          await fs.readFile(onboardingOutputPath, "utf8"),
        ),
        { complete: false, current_step: "workspace" },
      );
      assert.equal(
        mcp.toolCalls.filter((call) => call.name === "onboarding_next").length,
        onboardingCallsBeforeIncomplete + 1,
        "incomplete setup continuation must consult the authoritative step once",
      );

      await fs.writeFile(
        recoverySchemaPath,
        `${JSON.stringify(
          {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              current_step: { type: "string" },
              retried_write: { type: "boolean" },
            },
            required: ["code", "current_step", "retried_write"],
          },
          null,
          2,
        )}\n`,
      );
      const createCallsBefore = mcp.toolCalls.filter(
        (call) => call.name === "create_flow_item",
      ).length;
      const onboardingCallsBeforeRecovery = mcp.toolCalls.filter(
        (call) => call.name === "onboarding_next",
      ).length;
      await runModelExec({
        codexHome: devHome,
        env: buildEnv,
        schemaPath: recoverySchemaPath,
        outputPath: recoveryOutputPath,
        autoApproveMcpWrites: true,
        prompt:
          "Create a Nuanu Flow item named Acceptance gated write. Call create_flow_item once. If it returns onboarding_required, do not retry the write; call onboarding_next exactly once and return code onboarding_required, its current_step, and retried_write false.",
      });
      assert.deepEqual(
        parseJsonOutput(
          "gated operation recovery output",
          await fs.readFile(recoveryOutputPath, "utf8"),
        ),
        {
          code: "onboarding_required",
          current_step: "workspace",
          retried_write: false,
        },
      );
      assert.equal(
        mcp.toolCalls.filter((call) => call.name === "create_flow_item").length,
        createCallsBefore + 1,
        "a gated write must not be retried automatically",
      );
      assert.equal(
        mcp.toolCalls.filter((call) => call.name === "onboarding_next").length,
        onboardingCallsBeforeRecovery + 1,
        "a gated operation must perform one bounded recovery call",
      );

      await fs.writeFile(
        availabilitySchemaPath,
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
      mcp.state.available = false;
      const offlineStarted = Date.now();
      try {
        await runModelExec({
          codexHome: devHome,
          env: buildEnv,
          schemaPath: availabilitySchemaPath,
          outputPath: availabilityOutputPath,
          prompt:
            "Do not call any tools. Return marker exactly as unrelated-work-still-works.",
        });
      } finally {
        mcp.state.available = true;
      }
      assert.deepEqual(
        parseJsonOutput(
          "unrelated work during MCP outage",
          await fs.readFile(availabilityOutputPath, "utf8"),
        ),
        { marker: "unrelated-work-still-works" },
      );
      assert(
        Date.now() - offlineStarted < 30_000,
        "an optional unavailable Nuanu MCP must not block unrelated Codex work for 30 seconds",
      );
      console.log(
        "model-backed journey: ordinary usage, incomplete setup, gated recovery, and MCP-outage isolation passed",
      );
      return;
    }

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
    actualCodex(
      ["plugin", "add", "nuanu-flow-worker-dev@nuanu-dev", "--json"],
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
      workerPluginRoot: refreshed.workerPluginRoot,
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
    .filter(
      (arg) =>
        arg !== "--model" &&
        arg !== "--worker-only" &&
        arg !== "--sessions-only" &&
        arg !== "--journey" &&
        arg !== "--skip-credential-free",
    );
  if (unknownArgs.length) {
    throw new Error(`Unknown acceptance argument: ${unknownArgs[0]}`);
  }
  const version = actualCodex(["--version"]).stdout.trim();
  console.log(`acceptance Codex: ${version}`);
  const mcp = await startMcpFixture();
  try {
    if (!process.argv.includes("--skip-credential-free")) {
      await runCredentialFreeAcceptance(mcp);
    }
    if (!process.argv.includes("--model")) {
      console.log(
        "model-backed: skipped (run npm run test:acceptance:codex:model)",
      );
      return;
    }
    await runModelBackedAcceptance(mcp, {
      workerOnly: process.argv.includes("--worker-only"),
      sessionsOnly: process.argv.includes("--sessions-only"),
      journey: process.argv.includes("--journey"),
    });
  } finally {
    await mcp.close();
  }
}

main().catch((error) => {
  console.error(`[codex-acceptance] ${error.stack || error.message}`);
  process.exit(1);
});
