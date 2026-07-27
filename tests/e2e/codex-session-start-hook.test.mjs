import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hookScript = path.join(
  repoRoot,
  "plugins/nuanu-flow/hooks/session-start.mjs",
);

function runHook(payload) {
  return spawnSync(process.execPath, [hookScript], {
    cwd: repoRoot,
    encoding: "utf8",
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

function hookPayload(cwd, source = "startup") {
  return {
    session_id: "thread-test",
    transcript_path: null,
    cwd,
    hook_event_name: "SessionStart",
    model: "test",
    permission_mode: "default",
    source,
  };
}

async function makeGitRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-context-"));
  await fs.mkdir(path.join(root, ".git"));
  return root;
}

test("SessionStart hook injects compact task-tracker context for every supported source", () => {
  for (const source of ["startup", "resume", "clear", "compact"]) {
    const result = runHook(hookPayload(repoRoot, source));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const body = JSON.parse(result.stdout);
    assert.equal(
      body.hookSpecificOutput.hookEventName,
      "SessionStart",
    );
    const context = body.hookSpecificOutput.additionalContext;
    assert.match(context, /Nuanu Flow/);
    assert.match(context, /onboarding_next/);
    assert.match(context, /without retries/);
    assert(
      context.trim().split(/\s+/).length <= 80,
      `hook context for ${source} exceeds 80 words`,
    );
  }
});

test("SessionStart hook injects a root repository binding without a network lookup", async () => {
  const tempRoot = await makeGitRepo();
  const nested = path.join(tempRoot, "packages", "worker");
  try {
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, ".nuanu-flow.json"),
      `${JSON.stringify({
        $schema: "https://flow.nuanu.com/schemas/project-context.v1.json",
        version: 1,
        workspace_slug: "nuanu",
        project_identifier: "FLOW",
      })}\n`,
    );

    const result = runHook(hookPayload(nested));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const context = JSON.parse(
      result.stdout,
    ).hookSpecificOutput.additionalContext;
    assert.match(context, /Repository binding/);
    assert.match(context, /workspace "nuanu"/);
    assert.match(context, /project "FLOW"/);
    assert.match(context, /validate it lazily/);
    assert(
      context.trim().split(/\s+/).length <= 80,
      "hook context exceeds 80 words",
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("SessionStart hook chooses the most specific monorepo scope", async () => {
  const tempRoot = await makeGitRepo();
  const nested = path.join(tempRoot, "apps", "web", "components");
  try {
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, ".nuanu-flow.json"),
      `${JSON.stringify({
        version: 1,
        workspace_slug: "nuanu",
        project_identifier: "PLATFORM",
        scopes: [
          { path: ".", project_identifier: "ROOT" },
          { path: "apps", project_identifier: "APPS" },
          { path: "apps/web", project_identifier: "WEB" },
        ],
      })}\n`,
    );

    const result = runHook(hookPayload(nested));
    assert.equal(result.status, 0);
    const context = JSON.parse(
      result.stdout,
    ).hookSpecificOutput.additionalContext;
    assert.match(context, /scope "apps\/web"/);
    assert.match(context, /project "WEB"/);
    assert.doesNotMatch(context, /project "APPS"/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("SessionStart hook applies a valid local override and ignores an invalid one", async () => {
  const tempRoot = await makeGitRepo();
  const basePath = path.join(tempRoot, ".nuanu-flow.json");
  const localPath = path.join(tempRoot, ".nuanu-flow.local.json");
  try {
    await fs.writeFile(
      basePath,
      `${JSON.stringify({
        version: 1,
        workspace_slug: "nuanu",
        project_identifier: "FLOW",
      })}\n`,
    );
    await fs.writeFile(
      localPath,
      `${JSON.stringify({ project_identifier: "LOCAL" })}\n`,
    );

    let result = runHook(hookPayload(tempRoot));
    let context = JSON.parse(
      result.stdout,
    ).hookSpecificOutput.additionalContext;
    assert.match(context, /project "LOCAL"/);

    await fs.writeFile(
      localPath,
      `${JSON.stringify({ project_identifier: "lowercase-is-invalid" })}\n`,
    );
    result = runHook(hookPayload(tempRoot));
    context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /project "FLOW"/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("SessionStart hook fails open for malformed, unsafe, and oversized repository config", async () => {
  const tempRoot = await makeGitRepo();
  const configPath = path.join(tempRoot, ".nuanu-flow.json");
  try {
    for (const content of [
      "{not-json",
      JSON.stringify({
        version: 1,
        workspace_slug: "nuanu",
        project_identifier: "FLOW",
        access_token: "must-not-be-accepted",
      }),
      JSON.stringify({
        version: 1,
        workspace_slug: "nuanu",
        project_identifier: "FLOW",
        scopes: [
          { path: "../outside", project_identifier: "UNSAFE" },
        ],
      }),
      "x".repeat(4 * 1024 + 1),
    ]) {
      await fs.writeFile(configPath, content);
      const result = runHook(hookPayload(tempRoot));
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const context = JSON.parse(
        result.stdout,
      ).hookSpecificOutput.additionalContext;
      assert.match(context, /Nuanu Flow/);
      assert.doesNotMatch(context, /Repository binding/);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("SessionStart hook produces no context for malformed or unrelated input", () => {
  for (const payload of [
    "{not-json",
    {},
    { hook_event_name: "PostToolUse", source: "startup" },
    { hook_event_name: "SessionStart", source: "unknown" },
  ]) {
    const result = runHook(payload);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("plugin validator rejects escaped, missing, slow, and incorrectly matched hooks", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-hook-validation-"),
  );
  const pluginRoot = path.join(tempRoot, "plugin");
  const marketplaceRoot = path.join(tempRoot, "marketplace");
  const marketplacePath = path.join(
    marketplaceRoot,
    ".agents/plugins/marketplace.json",
  );
  try {
    await fs.cp(path.join(repoRoot, "plugins/nuanu-flow"), pluginRoot, {
      recursive: true,
    });
    await fs.mkdir(path.dirname(marketplacePath), { recursive: true });
    await fs.writeFile(
      marketplacePath,
      `${JSON.stringify({
        name: "nuanu",
        plugins: [
          {
            name: "nuanu-flow",
            source: { source: "local", path: "./../plugin" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          },
        ],
      })}\n`,
    );

    const manifestPath = path.join(pluginRoot, ".codex-plugin/plugin.json");
    const hooksPath = path.join(pluginRoot, "hooks/hooks.json");
    const originalManifest = await fs.readFile(manifestPath, "utf8");
    const originalHooks = await fs.readFile(hooksPath, "utf8");
    const validate = () =>
      spawnSync(
        process.execPath,
        [
          path.join(repoRoot, "scripts/validate-plugins.mjs"),
          "--codex-plugin",
          pluginRoot,
          "--codex-marketplace",
          marketplacePath,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );

    assert.equal(validate().status, 0);

    const manifest = JSON.parse(originalManifest);
    manifest.hooks = "./../outside.json";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.match(validate().stderr, /must stay inside the plugin root/);

    await fs.writeFile(manifestPath, originalManifest);
    const hooks = JSON.parse(originalHooks);
    hooks.hooks.SessionStart[0].matcher = "startup";
    hooks.hooks.SessionStart[0].hooks[0].timeout = 2;
    hooks.hooks.SessionStart[0].hooks[0].command =
      "node \"${PLUGIN_ROOT}/hooks/missing.mjs\"";
    await fs.writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    const invalid = validate();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /matcher must be startup\|resume\|clear\|compact/);
    assert.match(invalid.stderr, /at most one second/);
    assert.match(invalid.stderr, /target does not exist/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
