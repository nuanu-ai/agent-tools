import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const standaloneRoot = path.join(repoRoot, "skills");
const pluginRoot = path.join(repoRoot, "plugins/nuanu-flow/skills");
const portableRoot = path.join(standaloneRoot, "nuanu-flow");

const bundledReferences = [
  "artifacts.md",
  "bpmn-processes.md",
  "create-agent-design.md",
  "create-agent.md",
  "onboarding.md",
  "product-help-concepts.md",
  "product-help-how-to.md",
  "product-help-integrations.md",
  "product-help.md",
  "project-setup.md",
  "remote-worker.md",
  "work-items-payloads.md",
  "work-items.md",
  "workspace-setup.md",
];

async function filesBelow(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return files.sort();
}

test("standalone Agent Skills preserve every combined plugin skill", async () => {
  const standaloneFiles = await filesBelow(standaloneRoot);
  const pluginFiles = await filesBelow(pluginRoot);

  for (const relative of standaloneFiles) {
    if (relative.startsWith("nuanu-flow/references/")) continue;
    if (relative === "nuanu-flow/scripts/worker.mjs") continue;
    if (relative === "nuanu-flow/SKILL.md") continue;
    assert(pluginFiles.includes(relative), `unexpected standalone file ${relative}`);
  }

  for (const relative of pluginFiles) {
    assert(standaloneFiles.includes(relative), `missing standalone file ${relative}`);
    if (relative === "nuanu-flow/SKILL.md") continue;
    const [standalone, plugin] = await Promise.all([
      fs.readFile(path.join(standaloneRoot, relative)),
      fs.readFile(path.join(pluginRoot, relative)),
    ]);
    assert(
      standalone.equals(plugin),
      `${relative} differs between standalone and plugin distributions`,
    );
  }
});

test("the Nuanu Flow entry skill is a self-contained portable fallback", async () => {
  const entry = await fs.readFile(
    path.join(portableRoot, "SKILL.md"),
    "utf8",
  );
  assert.match(entry, /^---\n/);
  assert.match(entry, /^name:\s*nuanu-flow$/m);
  assert.match(entry, /^description:\s*\S+/m);
  assert.match(entry, /nuanu-flow.*MCP/i);
  assert.match(entry, /## Portable fallback bundle/);
  assert.match(entry, /scripts\/worker\.mjs/);
  assert(entry.split("\n").length < 500);

  for (const reference of bundledReferences) {
    const content = await fs.readFile(
      path.join(portableRoot, "references", reference),
      "utf8",
    );
    assert(content.trim().length > 0, `${reference} is empty`);
    assert(!content.startsWith("---\n"), `${reference} retained skill frontmatter`);
  }

  await fs.access(path.join(portableRoot, "scripts/worker.mjs"));
  for (const forbidden of [
    "hooks",
    ".mcp.json",
    ".codex-plugin",
    ".claude-plugin",
    "app_server_client.mjs",
    "adapter.mjs",
  ]) {
    await assert.rejects(fs.access(path.join(portableRoot, forbidden)));
  }
});

test("distributed skills describe repository binding only after project confirmation", async () => {
  const [entry, onboarding, projectSetup] = await Promise.all([
    fs.readFile(path.join(standaloneRoot, "nuanu-flow/SKILL.md"), "utf8"),
    fs.readFile(path.join(standaloneRoot, "onboarding/SKILL.md"), "utf8"),
    fs.readFile(path.join(standaloneRoot, "project-setup/SKILL.md"), "utf8"),
  ]);

  assert.match(entry, /most specific matching repository scope/);
  assert.match(entry, /performs no network call/);
  assert.match(
    onboarding,
    /Do not create `\.nuanu-flow\.json` during authentication/,
  );
  assert.match(projectSetup, /## 8\. Bind the Git repository/);
  assert.match(
    projectSetup,
    /https:\/\/flow\.nuanu\.com\/schemas\/project-context\.v1\.json/,
  );
  assert.match(projectSetup, /never overwrite a binding\s+silently/);
});

test("distributed work-item skill clarifies, shapes, estimates, and verifies creation", async () => {
  const body = await fs.readFile(
    path.join(standaloneRoot, "work-items/SKILL.md"),
    "utf8",
  );

  assert.match(body, /A title-only request is a brief, not a ready Flow item/);
  assert.match(body, /one compact,\s+grouped follow-up/);
  assert.match(body, /definition of done/i);
  assert.match(body, /omit empty boilerplate/);
  assert.match(body, /Call `list_estimates` before creation/);
  assert.match(body, /never replace a project's configured scale with Fibonacci/);
  assert.match(body, /values `1, 2, 3, 5, 8, 13`/);
  assert.match(body, /Finish with `get_issue`/);
});

test("portable manifest hashes every generated source and all local links resolve", async () => {
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(portableRoot, "references/manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.format_version, 1);
  assert.match(manifest.plugin_version, /^\d+\.\d+\.\d+/);
  assert.match(manifest.bundle_sha256, /^[a-f0-9]{64}$/);
  assert(Array.isArray(manifest.sources));
  assert(manifest.sources.length >= bundledReferences.length);

  for (const source of manifest.sources) {
    const bytes = await fs.readFile(path.join(repoRoot, source.path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      source.sha256,
      `${source.path} hash drifted`,
    );
  }

  const markdownFiles = (await filesBelow(portableRoot)).filter((file) =>
    file.endsWith(".md"),
  );
  for (const relative of markdownFiles) {
    const content = await fs.readFile(path.join(portableRoot, relative), "utf8");
    for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target) continue;
      await fs.access(path.resolve(path.dirname(path.join(portableRoot, relative)), target));
    }
  }
});
