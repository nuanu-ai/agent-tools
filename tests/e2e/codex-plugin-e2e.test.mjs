import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repoRoot, "plugins/nuanu-flow");
const manifestPath = path.join(pluginRoot, ".codex-plugin/plugin.json");
const marketplacePath = path.join(repoRoot, ".agents/plugins/marketplace.json");
const installPrompt = "Read and install https://flow.nuanu.com/install.md";
const remoteGuideUrl = "https://flow.nuanu.com/connect/remote-agent.md";

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
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.equal(typeof manifest.mcpServers, "object");
  assert.equal(manifest.interface.displayName, "Nuanu Flow");
  assert(manifest.interface.defaultPrompt.some((line) => line.includes("Flow items")));

  assert.equal(mcp["nuanu-flow"].type, "http");
  assert.equal(
    mcp["nuanu-flow"].url,
    "https://flow.nuanu.com/mcp-server/mcp",
  );
  assert.equal(mcp["nuanu-flow"].auth, "oauth");
  assert.equal(
    mcp["nuanu-flow"].env_http_headers["X-Agent-Key"],
    "NUANU_AGENT_KEY",
  );
  assert.equal(
    mcp["nuanu-flow"].http_headers["X-Agent-Client"],
    "Codex App",
  );
  assert.equal(mcp["nuanu-flow"].default_tools_approval_mode, "writes");

  assert.equal(marketplace.name, "nuanu");
  assert.equal(marketplace.plugins[0].name, "nuanu-flow");
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "local",
    path: "./plugins/nuanu-flow",
  });

  await fs.access(path.join(pluginRoot, manifest.skills));
  await fs.access(path.join(pluginRoot, manifest.hooks));
  await fs.access(path.join(pluginRoot, ".mcp.json"));
  const hooks = await readJson(path.join(pluginRoot, manifest.hooks));
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  assert.match(
    hooks.hooks.UserPromptSubmit[0].hooks[0].command,
    /user-prompt-submit\.mjs/,
  );
  assert.equal(
    hooks.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit,
    500,
  );
  await fs.access(
    path.join(pluginRoot, "hooks/user-prompt-submit.mjs"),
  );
  await fs.access(
    path.join(
      pluginRoot,
      "scripts/activity/remote-worker-activity.mjs",
    ),
  );
});

test("Codex auth doctor detects disabled OAuth metadata", async () => {
  const server = await startAuthMetadataServer();
  try {
    const result = await runNode(["scripts/codex/auth-doctor.mjs", "--json", "--url", server.url]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, "oauth-disabled");
    assert.match(
      body.hookStatus,
      /^(trusted|review_required|unsupported)$/,
    );
    assert.equal(body.probe, `${new URL(server.url).origin}/mcp-server/.well-known/oauth-protected-resource`);
  } finally {
    await server.close();
  }
});

test("public plugin exposes the one-prompt onboarding and remote enrollment flow", async () => {
  const manifest = await readJson(manifestPath);
  const rootReadme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const pluginReadme = await fs.readFile(path.join(pluginRoot, "README.md"), "utf8");
  const orientation = await fs.readFile(path.join(pluginRoot, "skills/nuanu-flow/SKILL.md"), "utf8");
  const codexSetup = await fs.readFile(path.join(pluginRoot, "skills/codex-setup/SKILL.md"), "utf8");

  await fs.access(path.join(pluginRoot, "skills/onboarding/SKILL.md"));
  await fs.access(path.join(pluginRoot, "scripts/worker/enroll.mjs"));
  await fs.access(path.join(pluginRoot, "scripts/worker/credentials.mjs"));

  assert.match(rootReadme, new RegExp(installPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(pluginReadme, new RegExp(installPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(pluginReadme, new RegExp(remoteGuideUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rootReadme, /App task with shell\s+access uses the same canonical Git marketplace/);
  assert.match(pluginReadme, /App task with shell\s+access\s+may install from the canonical Git marketplace/);
  assert.match(codexSetup, /do not stop solely for that reason/);
  assert.match(codexSetup, /The agent, not the user, runs the public `codex plugin` and\s+`codex mcp` commands/);
  assert.match(codexSetup, /select the installed \*\*Nuanu Flow\*\* plugin/);
  assert.match(codexSetup, /Codex App `@` mention\s+picker/);
  assert.match(codexSetup, /Do not claim that the App shows a native \*\*Continue\*\* button/);
  assert.match(codexSetup, /adding tool\s+descriptions to a prompt does not register their executable dispatcher/i);
  assert.match(codexSetup, /cannot\s+add MCP tool schemas to an already-running\s+one/);
  assert.match(codexSetup, /keep the current agent turn open and poll that same\s+process/);
  assert.match(codexSetup, /not a reason to finish the turn or ask the user to\s+reply `done`/);
  assert.doesNotMatch(codexSetup, /reopen the current task\s+from App history/);
  assert.doesNotMatch(codexSetup, /reopen_required/);
  assert.match(codexSetup, /attachment: restart_required/);
  assert.match(codexSetup, /Codex CLI loads new MCP tools only at process startup/);
  assert.match(
    codexSetup,
    /codex resume <thread-id> "Continue Nuanu Flow setup"/,
  );
  assert.match(
    rootReadme,
    /Run it in the same terminal to continue the\s+same conversation/,
  );
  assert.doesNotMatch(codexSetup, /report that official-directory dependency/);
  assert.match(orientation, /first workspace|zero workspaces/i);
  assert.match(orientation, /`onboarding`/);
  assert.equal(
    manifest.mcpServers["nuanu-flow"].url,
    "https://flow.nuanu.com/mcp-server/mcp",
  );
  assert.equal(manifest.mcpServers["nuanu-flow"].auth, "oauth");
});

test("public plugin exposes read-only product Q&A and its references", async () => {
  const orientation = await fs.readFile(
    path.join(pluginRoot, "skills/nuanu-flow/SKILL.md"),
    "utf8",
  );
  const productHelpRoot = path.join(
    pluginRoot,
    "skills/product-help",
  );
  const help = await fs.readFile(
    path.join(productHelpRoot, "SKILL.md"),
    "utf8",
  );
  const integrations = await fs.readFile(
    path.join(productHelpRoot, "references/integrations.md"),
    "utf8",
  );

  await fs.access(
    path.join(productHelpRoot, "references/concepts.md"),
  );
  await fs.access(
    path.join(productHelpRoot, "references/how-to.md"),
  );
  assert.match(orientation, /`product-help`/);
  assert.match(help, /Read-only by default/);
  assert.match(help, /get_agent_creation_options/);
  assert.match(
    integrations,
    /Instagram is not in the curated integration catalog in this build/,
  );
});
