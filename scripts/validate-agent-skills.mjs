#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skillsRoot = path.join(repositoryRoot, "skills");
const entries = await readdir(skillsRoot, { withFileTypes: true });
const skillNames = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const skillName of skillNames) {
  const relativePath = path.join("skills", skillName);
  const result = spawnSync(
    "uvx",
    ["--from", "skills-ref", "agentskills", "validate", relativePath],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "uvx is required for Agent Skills reference validation; install uv first",
    );
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Agent Skills reference validation failed: ${skillName}`);
  }
  process.stdout.write(`Agent Skills spec: ${skillName} passed\n`);
}
