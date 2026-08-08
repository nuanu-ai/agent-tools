#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./modes.mjs";

const CANONICAL_VERSION = /^\d+\.\d+\.\d+$/;

export function nextVersion(current, request) {
  if (!CANONICAL_VERSION.test(current)) {
    throw new Error(
      `Current plugin version must be a canonical semantic version: ${current}`,
    );
  }
  if (CANONICAL_VERSION.test(request)) return request;
  if (!["patch", "minor", "major"].includes(request)) {
    throw new Error(
      `Version request must be patch, minor, major, or an exact X.Y.Z version; received ${request}`,
    );
  }
  let [major, minor, patch] = current.split(".").map(Number);
  if (request === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (request === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

export async function updateManifestVersion(options) {
  const manifestPaths = options.manifestPaths?.length
    ? options.manifestPaths
    : options.manifestPath
      ? [options.manifestPath]
    : [
        path.join(
          REPO_ROOT,
          "plugins/nuanu-flow/.codex-plugin/plugin.json",
        ),
        path.join(
          REPO_ROOT,
          "plugins/nuanu-flow/.claude-plugin/plugin.json",
        ),
      ];
  const manifests = await Promise.all(
    manifestPaths.map(async (manifestPath) => ({
      manifestPath,
      manifest: JSON.parse(await fs.readFile(manifestPath, "utf8")),
    })),
  );
  const versions = new Set(manifests.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    throw new Error(
      `Production plugin manifests must share one version: ${[...versions].join(", ")}`,
    );
  }
  const oldVersion = manifests[0].manifest.version;
  const newVersion = nextVersion(oldVersion, options.request);
  const willChange = newVersion !== oldVersion;
  if (!options.dryRun && willChange) {
    for (const { manifestPath, manifest } of manifests) {
      const temp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(
        temp,
        `${JSON.stringify({ ...manifest, version: newVersion }, null, 2)}\n`,
      );
      await fs.rename(temp, manifestPath);
    }
  }
  return {
    oldVersion,
    newVersion,
    changed: !options.dryRun && willChange,
    dryRun: Boolean(options.dryRun),
  };
}

function parseArgs(argv) {
  const options = { request: "", manifestPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--manifest-path") {
      const manifestPath = argv[index + 1];
      if (!manifestPath) throw new Error("--manifest-path requires a path");
      options.manifestPaths.push(manifestPath);
      index += 1;
    }
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (!options.request) options.request = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.request) {
    console.log(
      "Usage: node scripts/codex/version.mjs <patch|minor|major|X.Y.Z> " +
        "[--dry-run] [--manifest-path PATH ...]",
    );
    if (!options.help) process.exitCode = 1;
    return;
  }
  const result = await updateManifestVersion(options);
  console.log(
    `${result.dryRun ? "would update" : result.changed ? "updated" : "unchanged"} plugin version: ${result.oldVersion} -> ${result.newVersion}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[plugin-version] ${error.message}`);
    process.exit(1);
  });
}
