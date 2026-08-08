import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = path.join(repoRoot, "plugins/nuanu-flow-worker");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

test("production marketplaces publish the managed worker companion", async () => {
  const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
  const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");
  const codexWorker = codexMarketplace.plugins.find(
    (plugin) => plugin.name === "nuanu-flow-worker",
  );
  const claudeWorker = claudeMarketplace.plugins.find(
    (plugin) => plugin.name === "nuanu-flow-worker",
  );

  assert.deepEqual(codexWorker?.source, {
    source: "local",
    path: "./plugins/nuanu-flow-worker",
  });
  assert.equal(codexWorker?.policy?.installation, "AVAILABLE");
  assert.equal(claudeWorker?.source, "./plugins/nuanu-flow-worker");
});

test("managed worker plugin ships the bootstrap runtime without a second MCP", async () => {
  const generalManifest = await readJson("plugins/nuanu-flow/.codex-plugin/plugin.json");
  const workerManifest = await readJson(
    "plugins/nuanu-flow-worker/.codex-plugin/plugin.json",
  );

  assert.equal(workerManifest.name, "nuanu-flow-worker");
  assert.equal(workerManifest.version, generalManifest.version);
  assert.equal(workerManifest.mcpServers, undefined);
  for (const relativePath of [
    "scripts/worker/enroll.mjs",
    "scripts/worker/worker.mjs",
    "scripts/worker/managed_supervisor.mjs",
    "scripts/worker/portable-worker.mjs",
    "skills/remote-worker/SKILL.md",
    "skills/codex-remote-worker/SKILL.md",
    "skills/claude-code-remote-worker/SKILL.md",
  ]) {
    await access(path.join(workerRoot, relativePath));
  }
});
