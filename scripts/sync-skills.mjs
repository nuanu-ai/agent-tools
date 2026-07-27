#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(repoRoot, "plugins/nuanu-flow/skills");
const targetRoot = path.join(repoRoot, "skills");
const pluginManifestPath = path.join(
  repoRoot,
  "plugins/nuanu-flow/.codex-plugin/plugin.json",
);
const portableWorkerPath = path.join(
  repoRoot,
  "plugins/nuanu-flow/scripts/worker/portable-worker.mjs",
);

const canonicalSkills = [
  "artifacts",
  "bpmn-processes",
  "claude-code-remote-worker",
  "codex-remote-worker",
  "codex-setup",
  "create-agent",
  "nuanu-flow",
  "onboarding",
  "project-setup",
  "remote-worker",
  "work-items",
  "workspace-setup",
];

const bundledSkills = [
  "artifacts",
  "bpmn-processes",
  "create-agent",
  "onboarding",
  "project-setup",
  "remote-worker",
  "work-items",
  "workspace-setup",
];

const bundledSupportingReferences = [
  {
    source: "plugins/nuanu-flow/skills/create-agent/references/agent-design.md",
    target: "create-agent-design.md",
  },
  {
    source: "plugins/nuanu-flow/skills/work-items/references/payloads.md",
    target: "work-items-payloads.md",
  },
];

const supportingReferenceRewrites = new Map([
  ["references/agent-design.md", "create-agent-design.md"],
  ["references/payloads.md", "work-items-payloads.md"],
]);

const portableFallbackSection = `
## Portable fallback bundle

This standalone skill may be installed without the Nuanu Flow plugin. Agent
Skills do not provide one universal MCP-registration or OAuth format. Use the
current agent's native remote-HTTP MCP connection flow for the environment:

- Production MCP: \`https://flow.nuanu.com/mcp-server/mcp\`
- Local MCP: \`http://localhost:3001/mcp\`

Never substitute production when a localhost URL was requested. If the
\`nuanu-flow\` MCP server is already available, use it directly. If the agent
cannot connect remote HTTP MCP with OAuth, stop at authentication and explain
that limitation; do not request or expose credentials as a workaround.

When a matching peer Nuanu skill is installed, load it normally. Otherwise
read exactly the relevant bundled reference:

| Job | Bundled reference |
| --- | --- |
| First-run account and workspace onboarding | [onboarding](references/onboarding.md) |
| Existing workspace context, goals, and teammates | [workspace setup](references/workspace-setup.md) |
| Project scaffolding | [project setup](references/project-setup.md) |
| Work items, cycles, relations, and comments | [work items](references/work-items.md) |
| BPMN process authoring and operation | [BPMN processes](references/bpmn-processes.md) |
| Versioned files and documents | [artifacts](references/artifacts.md) |
| Agent design, creation, or connection | [create agent](references/create-agent.md) |
| Generic remote-worker operation | [remote worker](references/remote-worker.md) |

For a generic remote agent, use the bundled zero-dependency polling worker.
It has no hooks and does not install a plugin:

\`\`\`bash
node scripts/worker.mjs enroll --base-url https://flow.nuanu.com/api
node scripts/worker.mjs status
node scripts/worker.mjs run --command "<non-interactive text-in/text-out command>"
\`\`\`

Use \`http://localhost:8000/api\` only for a local enrollment prompt. Pass the
single-use \`nuanu_join_...\` token to \`enroll\` through standard input, never
as an argument, environment variable, URL, or file. The worker stores the
durable key outside the project with private permissions and gives spawned
agent commands only task-scoped credentials.
`;

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
  try {
    await visit(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files.sort();
}

function parseSkill(relativeDirectory, content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`${relativeDirectory}/SKILL.md has invalid frontmatter`);
  }
  const name = match[1].match(/^name:\s*(\S+)\s*$/m)?.[1];
  const description = match[1].match(/^description:\s*(.+)\s*$/m)?.[1];
  if (name !== relativeDirectory) {
    throw new Error(
      `${relativeDirectory}/SKILL.md name must match its directory`,
    );
  }
  if (!description) {
    throw new Error(`${relativeDirectory}/SKILL.md needs a description`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`${relativeDirectory}/SKILL.md has an invalid name`);
  }
  return {
    frontmatter: match[1],
    body: match[2],
  };
}

function rewriteSupportingReferences(content) {
  let rewritten = content;
  for (const [source, target] of supportingReferenceRewrites) {
    rewritten = rewritten.replaceAll(source, target);
  }
  return rewritten;
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function sourceRecord(relativePath) {
  return {
    path: relativePath,
    sha256: await sha256File(path.join(repoRoot, relativePath)),
  };
}

async function copyCanonicalSkills(outputRoot) {
  const sourceEntries = await fs.readdir(sourceRoot, { withFileTypes: true });
  const unexpectedDirectories = sourceEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !canonicalSkills.includes(name))
    .sort();
  if (unexpectedDirectories.length) {
    throw new Error(
      `Canonical skill allowlist is missing: ${unexpectedDirectories.join(", ")}`,
    );
  }

  for (const skillName of canonicalSkills) {
    const sourceDirectory = path.join(sourceRoot, skillName);
    const skillFile = path.join(sourceDirectory, "SKILL.md");
    parseSkill(skillName, await fs.readFile(skillFile, "utf8"));
    await fs.cp(sourceDirectory, path.join(outputRoot, skillName), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
}

async function compilePortableBundle(outputRoot) {
  const portableRoot = path.join(outputRoot, "nuanu-flow");
  const referencesRoot = path.join(portableRoot, "references");
  const scriptsRoot = path.join(portableRoot, "scripts");
  await Promise.all([
    fs.mkdir(referencesRoot, { recursive: true }),
    fs.mkdir(scriptsRoot, { recursive: true }),
  ]);

  const routerPath = path.join(sourceRoot, "nuanu-flow/SKILL.md");
  const router = await fs.readFile(routerPath, "utf8");
  await fs.writeFile(
    path.join(portableRoot, "SKILL.md"),
    `${router.trimEnd()}\n${portableFallbackSection}`,
    "utf8",
  );

  const sourcePaths = [
    "plugins/nuanu-flow/skills/nuanu-flow/SKILL.md",
  ];
  for (const skillName of bundledSkills) {
    const relativePath = `plugins/nuanu-flow/skills/${skillName}/SKILL.md`;
    const content = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
    const { body } = parseSkill(skillName, content);
    await fs.writeFile(
      path.join(referencesRoot, `${skillName}.md`),
      rewriteSupportingReferences(body).trimStart(),
      "utf8",
    );
    sourcePaths.push(relativePath);
  }

  for (const reference of bundledSupportingReferences) {
    const content = await fs.readFile(
      path.join(repoRoot, reference.source),
      "utf8",
    );
    await fs.writeFile(
      path.join(referencesRoot, reference.target),
      rewriteSupportingReferences(content),
      "utf8",
    );
    sourcePaths.push(reference.source);
  }

  await fs.copyFile(
    portableWorkerPath,
    path.join(scriptsRoot, "worker.mjs"),
  );
  await fs.chmod(path.join(scriptsRoot, "worker.mjs"), 0o755);
  sourcePaths.push(
    "plugins/nuanu-flow/scripts/worker/portable-worker.mjs",
  );

  const pluginManifest = JSON.parse(
    await fs.readFile(pluginManifestPath, "utf8"),
  );
  const sources = [];
  for (const relativePath of [...new Set(sourcePaths)].sort()) {
    sources.push(await sourceRecord(relativePath));
  }
  const bundleSha256 = createHash("sha256")
    .update(
      sources
        .map((source) => `${source.path}\0${source.sha256}\n`)
        .join(""),
    )
    .digest("hex");
  const manifest = {
    format_version: 1,
    plugin_version: pluginManifest.version,
    bundle_sha256: bundleSha256,
    sources,
  };
  await fs.writeFile(
    path.join(referencesRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function build(outputRoot) {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await copyCanonicalSkills(outputRoot);
  await compilePortableBundle(outputRoot);
}

async function differences(expectedRoot, actualRoot) {
  const expectedFiles = await filesBelow(expectedRoot);
  const actualFiles = await filesBelow(actualRoot);
  const changed = [];
  const allFiles = [...new Set([...expectedFiles, ...actualFiles])].sort();
  for (const relative of allFiles) {
    if (!expectedFiles.includes(relative)) {
      changed.push(`extra ${relative}`);
      continue;
    }
    if (!actualFiles.includes(relative)) {
      changed.push(`missing ${relative}`);
      continue;
    }
    const [expected, actual] = await Promise.all([
      fs.readFile(path.join(expectedRoot, relative)),
      fs.readFile(path.join(actualRoot, relative)),
    ]);
    if (!expected.equals(actual)) changed.push(`changed ${relative}`);
  }
  return changed;
}

async function main() {
  const check = process.argv.slice(2).includes("--check");
  const unknown = process.argv
    .slice(2)
    .filter((argument) => argument !== "--check");
  if (unknown.length) {
    throw new Error(`Unknown argument: ${unknown[0]}`);
  }
  const expectedTarget = path.join(repoRoot, "skills");
  if (path.resolve(targetRoot) !== expectedTarget) {
    throw new Error(`Refusing to replace unexpected skills path: ${targetRoot}`);
  }

  const temporary = path.join(
    repoRoot,
    `.skills.tmp-${process.pid}-${Date.now()}`,
  );
  try {
    await build(temporary);
    if (check) {
      const changed = await differences(temporary, targetRoot);
      if (changed.length) {
        throw new Error(
          `Standalone skills are out of sync:\n- ${changed.join(
            "\n- ",
          )}\nRun npm run sync:skills.`,
        );
      }
      console.log(
        `Standalone skills and portable fallback are current (${(
          await filesBelow(targetRoot)
        ).length} files).`,
      );
      return;
    }

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.rename(temporary, targetRoot);
    console.log(
      `Compiled ${canonicalSkills.length} Agent Skills and the portable fallback bundle.`,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[sync-skills] ${error.message}`);
  process.exit(1);
});
