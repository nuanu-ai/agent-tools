#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sourceSkillRoot = path.join(repositoryRoot, "skills", "nuanu-flow");
const skillsCli = "skills@1.5.20";
const requiredFiles = [
  "SKILL.md",
  "references/artifacts.md",
  "references/bpmn-processes.md",
  "references/create-agent-design.md",
  "references/create-agent.md",
  "references/manifest.json",
  "references/onboarding.md",
  "references/project-setup.md",
  "references/remote-worker.md",
  "references/work-items-payloads.md",
  "references/work-items.md",
  "references/workspace-setup.md",
  "scripts/worker.mjs",
];
const forbiddenPaths = [
  ".claude-plugin",
  ".codex-plugin",
  ".mcp.json",
  "hooks",
  "scripts/worker/adapter.mjs",
  "scripts/worker/worker.mjs",
];

function runNpx(args, { cwd, home }) {
  return execFileSync("npx", ["--yes", skillsCli, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      NO_COLOR: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function filesBelow(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function treeHash(root) {
  const hash = createHash("sha256");
  for (const relative of await filesBelow(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertInstalledSkill(skillRoot) {
  for (const relative of requiredFiles) {
    await access(path.join(skillRoot, relative));
  }
  for (const relative of forbiddenPaths) {
    await assert.rejects(access(path.join(skillRoot, relative)));
  }
  assert.equal(
    await treeHash(skillRoot),
    await treeHash(sourceSkillRoot),
    "installed portable skill must match the generated source byte-for-byte",
  );

  const manifest = JSON.parse(
    await readFile(path.join(skillRoot, "references", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.format_version, 1);
  assert.match(manifest.plugin_version, /^\d+\.\d+\.\d+/);
  assert.match(manifest.bundle_sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.sources.length >= 10);

  const executed = (() => {
    try {
      execFileSync(
        process.execPath,
        [path.join(skillRoot, "scripts", "worker.mjs"), "invalid-command"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return { code: 0, stderr: "" };
    } catch (error) {
      return {
        code: error.status ?? 1,
        stderr: error.stderr?.toString() ?? "",
      };
    }
  })();
  assert.notEqual(executed.code, 0);
  assert.match(executed.stderr, /Usage: worker\.mjs/);
}

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "nuanu-agent-skills-acceptance-"),
);

try {
  const listHome = path.join(temporaryRoot, "list-home");
  const listProject = path.join(temporaryRoot, "list-project");
  await mkdir(listHome, { recursive: true });
  await mkdir(listProject, { recursive: true });
  const listOutput = runNpx(
    ["add", repositoryRoot, "--list"],
    { cwd: listProject, home: listHome },
  );
  assert.match(listOutput, /\bnuanu-flow\b/);

  const targets = [
    {
      agent: "codex",
      relativeRoot: ".agents/skills/nuanu-flow",
    },
    {
      agent: "claude-code",
      relativeRoot: ".claude/skills/nuanu-flow",
    },
    {
      agent: "universal",
      relativeRoot: ".agents/skills/nuanu-flow",
    },
  ];

  for (const target of targets) {
    const targetRoot = path.join(temporaryRoot, target.agent);
    const home = path.join(targetRoot, "home");
    const project = path.join(targetRoot, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    runNpx(
      [
        "add",
        repositoryRoot,
        "--skill",
        "nuanu-flow",
        "--agent",
        target.agent,
        "--copy",
        "-y",
      ],
      { cwd: project, home },
    );
    await assertInstalledSkill(path.join(project, target.relativeRoot));
    await access(path.join(project, "skills-lock.json"));
    process.stdout.write(`portable skill install: ${target.agent} passed\n`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
