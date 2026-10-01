#!/usr/bin/env node
// Canonical in Nuanu Flow; exported as agent-tools/scripts/sync-skills.mjs.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "skills");
const plugins = ["nuanu-flow", "nuanu-flow-worker"];
const expected = new Map();
const sources = [];

async function tree(directory, prefix = "") {
  const files = new Map();
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) for (const [file, content] of await tree(directory, name)) files.set(file, content);
    else if (entry.isFile()) files.set(name, await fs.readFile(path.join(directory, name)));
    else throw new Error(`Unsupported skill entry: ${name}`);
  }
  return files;
}

for (const plugin of plugins) {
  const release = JSON.parse(await fs.readFile(path.join(root, "plugins", plugin, "release.json"), "utf8"));
  if (release.environment !== "production")
    throw new Error("Standalone distribution skills require a generated production bundle");
  for (const [file, content] of await tree(path.join(root, "plugins", plugin, "skills"))) {
    if (file.startsWith("source-command-")) continue;
    if (expected.has(file)) throw new Error(`Duplicate skill ownership: ${file}`);
    expected.set(file, content);
    sources.push({
      path: `plugins/${plugin}/skills/${file}`,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
}

// A standalone root skill must work without peer-skill discovery or hooks.
// Preserve each reference directory rather than flattening relative links.
const references = [];
for (const [file, content] of [...expected]) {
  const [skill, ...rest] = file.split("/");
  if (skill === "nuanu-flow") continue;
  expected.set(`nuanu-flow/references/domains/${skill}/${rest.join("/")}`, content);
  if (rest.join("/") === "SKILL.md") references.push(`- [${skill}](references/domains/${skill}/SKILL.md)`);
}
const router = expected.get("nuanu-flow/SKILL.md").toString();
expected.set(
  "nuanu-flow/SKILL.md",
  Buffer.from(
    `${router.trimEnd()}\n\n## Standalone usage\n\nUse the current host's native MCP connection. No hook or local cache is required.\nRead the current project Flow through MCP before substantive work and handoffs.\nChoose the user's explicit environment; never fall back from localhost to production.\nIf peer skills are not installed, read the relevant bundled domain reference:\n\n${references.sort().join("\n")}\n`
  )
);
const release = JSON.parse(await fs.readFile(path.join(root, "plugins/nuanu-flow/release.json"), "utf8"));
sources.sort((a, b) => a.path.localeCompare(b.path));
expected.set(
  "nuanu-flow/references/manifest.json",
  Buffer.from(
    `${JSON.stringify({ format_version: 2, plugin_version: release.version, source_commit: release.source_commit, bundle_sha256: createHash("sha256").update(JSON.stringify(sources)).digest("hex"), sources }, null, 2)}\n`
  )
);
const owned = [...new Set([...expected.keys()].map((file) => file.split("/")[0]))].sort();
const check = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: sync-skills.mjs [--check]");
if (check) {
  for (const skill of owned) {
    const actual = await tree(path.join(output, skill));
    const desired = new Map(
      [...expected]
        .filter(([file]) => file.startsWith(`${skill}/`))
        .map(([file, content]) => [file.slice(skill.length + 1), content])
    );
    if (actual.size !== desired.size || [...desired].some(([file, content]) => !actual.get(file)?.equals(content)))
      throw new Error(`Standalone skill is stale: ${skill}`);
  }
} else {
  // Replace only these Nuanu-owned skill directories. Other products survive.
  for (const skill of owned) await fs.rm(path.join(output, skill), { recursive: true, force: true });
  for (const [file, content] of expected) {
    await fs.mkdir(path.dirname(path.join(output, file)), { recursive: true });
    await fs.writeFile(path.join(output, file), content);
  }
}
console.log(`${check ? "Verified" : "Generated"} ${owned.length} standalone skills and the portable domain bundle.`);
