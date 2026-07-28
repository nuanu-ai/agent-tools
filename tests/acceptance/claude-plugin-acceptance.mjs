#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildClaudeDevPackage } from "../../scripts/claude/dev-package.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const claudeBin = process.env.CLAUDE_BIN || "claude";

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
  const nonce = randomUUID();
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
          name: "nuanu-flow-claude-acceptance",
          version: "1.0.0",
        },
      };
    } else if (body.method === "tools/list") {
      result = {
        tools: [
          {
            name: "flow_dev_identity",
            description:
              "Return the fixed Nuanu Flow Claude plugin identity for acceptance testing.",
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
      assert.equal(body.params?.name, "flow_dev_identity");
      const identity = {
        host: "Claude Code",
        authenticated: Boolean(req.headers["x-plane-user-token"]),
        nonce,
      };
      toolCalls.push({
        ...identity,
        client: req.headers["x-agent-client"] || "",
        token: req.headers["x-plane-user-token"] || "",
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
        error: {
          code: -32601,
          message: `unsupported method ${body.method}`,
        },
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
    nonce,
    toolCalls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamModelResponse(res, response) {
  const messageId = `msg_acceptance_${randomUUID().replaceAll("-", "")}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 32, output_tokens: 0 },
    },
  });
  if (response.type === "tool_use") {
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_nuanu_flow_acceptance",
        name: response.name,
        input: {},
      },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    });
  } else {
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: response.text },
    });
  }
  writeSse(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: response.type === "tool_use" ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 16 },
  });
  writeSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function startModelFixture(identity) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (
      req.method === "POST" &&
      req.url?.startsWith("/v1/messages/count_tokens")
    ) {
      return jsonResponse(res, 200, { input_tokens: 32 });
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      return jsonResponse(res, 404, { error: "not found" });
    }
    const body = await readJsonBody(req);
    requests.push(body);
    const hasToolResult = JSON.stringify(body.messages || []).includes(
      '"tool_result"',
    );
    if (!hasToolResult) {
      const tool = (body.tools || []).find((entry) =>
        entry.name?.endsWith("flow_dev_identity"),
      );
      assert(tool, "Claude did not load the Flow MCP tool into the model turn");
      return streamModelResponse(res, {
        type: "tool_use",
        name: tool.name,
      });
    }
    return streamModelResponse(res, {
      type: "text",
      text: JSON.stringify(identity),
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runClaude(args, options = {}) {
  const result = spawnSync(claudeBin, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `claude ${args.join(" ")} failed (${result.status}):\n${String(
        result.stderr || result.stdout || "",
      ).trim()}`,
    );
  }
  return String(result.stdout || "");
}

function runClaudeAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeout || 300000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(
          new Error(
            `claude ${args.join(" ")} failed (${status}):\n${String(
              stderr || stdout,
            ).trim()}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function structuredResult(output) {
  const envelope = JSON.parse(output);
  if (envelope.is_error) {
    throw new Error(`Claude returned an error: ${JSON.stringify(envelope)}`);
  }
  if (envelope.structured_output) return envelope.structured_output;
  if (typeof envelope.result === "string") return JSON.parse(envelope.result);
  return envelope.result;
}

async function main() {
  const liveModel = process.argv.slice(2).includes("--live-model");
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-claude-plugin-acceptance-"),
  );
  const mcp = await startMcpFixture();
  const expectedIdentity = {
    host: "Claude Code",
    authenticated: true,
    nonce: mcp.nonce,
  };
  const model = liveModel ? null : await startModelFixture(expectedIdentity);
  try {
    const build = await buildClaudeDevPackage({
      buildRoot: path.join(temporary, "claude-dev"),
      env: { NUANU_DEV_MCP_URL: mcp.url },
      force: true,
    });
    runClaude(["plugin", "validate", build.pluginRoot, "--strict"]);

    const {
      ANTHROPIC_API_KEY: _anthropicApiKey,
      ANTHROPIC_AUTH_TOKEN: _anthropicAuthToken,
      CLAUDE_CODE_OAUTH_TOKEN: _claudeOauthToken,
      ...cleanEnvironment
    } = process.env;
    const output = await runClaudeAsync(
      [
        "--plugin-dir",
        build.pluginRoot,
        "--allowedTools",
        "mcp__plugin_nuanu-flow-dev_mcp__*",
        "--permission-mode",
        "dontAsk",
        "--no-chrome",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--max-budget-usd",
        "1",
        "--print",
        "Call the MCP tool flow_dev_identity exactly once. Return only the tool response fields. Do not infer values or inspect files.",
      ],
      {
        cwd: temporary,
        env: {
          ...(liveModel ? process.env : cleanEnvironment),
          NUANU_DEV_TOKEN: "acceptance-claude-token",
          ...(model
            ? {
                ANTHROPIC_API_KEY: "acceptance-local-api-key",
                ANTHROPIC_BASE_URL: model.url,
                ANTHROPIC_CONFIG_DIR: path.join(temporary, "anthropic-config"),
                CLAUDE_CONFIG_DIR: path.join(temporary, "claude-config"),
                CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(
                  temporary,
                  "claude-secure-storage",
                ),
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              }
            : {}),
        },
      },
    );
    const identity = structuredResult(output);
    assert.deepEqual(identity, expectedIdentity);
    assert.equal(mcp.toolCalls.length, 1);
    assert.equal(mcp.toolCalls[0].token, "acceptance-claude-token");
    assert.equal(mcp.toolCalls[0].client, "Claude Code [DEV]");
    if (model) {
      assert.equal(model.requests.length, 2);
    }
    console.log(
      `Claude plugin acceptance passed (${liveModel ? "live model" : "deterministic model fixture"}): called Flow MCP marker ${mcp.nonce}`,
    );
  } finally {
    if (model) await model.close();
    await mcp.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[claude-plugin-acceptance] ${error.stack || error.message}`);
  process.exit(1);
});
