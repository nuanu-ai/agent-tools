import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repoRoot, "plugins/nuanu-flow");
const manifestPath = path.join(pluginRoot, ".codex-plugin/plugin.json");
const marketplacePath = path.join(repoRoot, ".agents/plugins/marketplace.json");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function startAuthMetadataServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/mcp-server/.well-known/oauth-protected-resource") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "oauth_disabled" }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp-server/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runNode(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("Codex plugin metadata points at skills and OAuth-ready Flow MCP config", async () => {
  const manifest = await readJson(manifestPath);
  const marketplace = await readJson(marketplacePath);
  const mcp = manifest.mcpServers;

  assert.equal(manifest.name, "nuanu-flow");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(\+[0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.skills, "./skills");
  assert.equal(typeof manifest.mcpServers, "object");
  assert.equal(manifest.interface.displayName, "Nuanu Flow");
  assert(manifest.interface.defaultPrompt.some((line) => line.includes("work items")));

  assert.equal(mcp.flow.type, "http");
  assert.equal(mcp.flow.url, "https://flow.nuanu.com/mcp-server/mcp");
  assert.equal(mcp.flow.auth, "oauth");
  assert.equal(mcp.flow.env_http_headers["X-Agent-Key"], "NUANU_AGENT_KEY");
  assert.equal(mcp.flow.default_tools_approval_mode, "writes");

  assert.equal(marketplace.name, "nuanu");
  assert.equal(marketplace.plugins[0].name, "nuanu-flow");
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "local",
    path: "./plugins/nuanu-flow",
  });

  await fs.access(path.join(pluginRoot, manifest.skills));
  await fs.access(path.join(pluginRoot, ".mcp.json"));
});

test("local Codex dev installer targets only the isolated development plugin", async () => {
  const before = await fs.readFile(manifestPath, "utf8");
  const result = spawnSync(process.execPath, ["scripts/codex/dev-install.mjs", "--dry-run", "--cachebuster=fixed"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const after = await fs.readFile(manifestPath, "utf8");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(after, before);
  assert.match(result.stdout, /deprecated/i);
  assert.match(result.stdout, /codex plugin marketplace add .*\.build\/codex-dev --json/);
  assert.match(result.stdout, /codex plugin add nuanu-flow-dev@nuanu-dev --json/);
  assert.doesNotMatch(result.stdout, /plugin remove/);
  assert.doesNotMatch(result.stdout, /marketplace remove nuanu(?:\s|$)/);
  assert.doesNotMatch(result.stdout, /nuanu-flow@nuanu(?:\s|$)/);
});

test("Codex auth doctor detects disabled OAuth metadata", async () => {
  const server = await startAuthMetadataServer();
  try {
    const result = await runNode(["scripts/codex/auth-doctor.mjs", "--json", "--url", server.url]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, "oauth-disabled");
    assert.equal(body.probe, `${new URL(server.url).origin}/mcp-server/.well-known/oauth-protected-resource`);
  } finally {
    await server.close();
  }
});
