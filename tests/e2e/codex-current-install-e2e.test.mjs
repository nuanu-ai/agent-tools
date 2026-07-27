import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCurrentProfile } from "../../scripts/codex/install-current.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fakeCodexBin = path.join(repoRoot, "tests/fixtures/fake-codex.mjs");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("current-profile development install delegates browser OAuth to Codex and prints the exact resume command", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-current-install-"),
  );
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "commands.jsonl");
  let wrapperBrowserOpenAttempts = 0;
  const threadId = "019f9d90-ca3a-7e82-9893-13f2bae0e31e";

  try {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        marketplaces: [],
        installed: [],
        mcpAuth: {},
      })}\n`,
    );

    const report = await installCurrentProfile("dev", {
      repoRoot,
      buildRoot,
      codexHome,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        CODEX_THREAD_ID: threadId,
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
        FAKE_EXPECT_CODEX_HOME: codexHome,
      },
      openBrowser() {
        wrapperBrowserOpenAttempts += 1;
        return true;
      },
      now: () => new Date("2026-07-26T10:00:00Z"),
    });

    assert.equal(report.pluginId, "nuanu-flow-dev@nuanu-dev");
    assert.equal(report.mcpUrl, "http://localhost:3001/mcp");
    assert.equal(report.authStatus, "o_auth");
    assert.equal(report.hookStatus, "review_required");
    assert.equal(
      report.resumeCommand,
      `codex resume ${threadId} "Continue Nuanu Flow setup"`,
    );
    assert.equal(wrapperBrowserOpenAttempts, 0);

    const state = await readJson(statePath);
    assert.deepEqual(
      state.installed.map((plugin) => plugin.pluginId),
      ["nuanu-flow-dev@nuanu-dev"],
    );
    assert.equal(state.mcpAuth["nuanu-flow"], "o_auth");
    const commands = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(commands.some((args) => args[0] === "plugin" && args[1] === "add"));
    assert(commands.some((args) => args[0] === "mcp" && args[1] === "login"));

    const second = await installCurrentProfile("dev", {
      repoRoot,
      buildRoot,
      codexHome,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        CODEX_THREAD_ID: threadId,
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
        FAKE_EXPECT_CODEX_HOME: codexHome,
        FAKE_HOOK_TRUST: "trusted",
      },
      openBrowser() {
        wrapperBrowserOpenAttempts += 1;
        return true;
      },
      now: () => new Date("2026-07-26T10:01:00Z"),
    });
    assert.deepEqual(second.actions, []);
    assert.equal(second.hookStatus, "trusted");
    assert.equal(wrapperBrowserOpenAttempts, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("current-profile install refuses a foreign development marketplace", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-current-foreign-"),
  );
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "commands.jsonl");

  try {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        marketplaces: [
          {
            name: "nuanu-dev",
            root: "/tmp/foreign",
            marketplaceSource: {
              sourceType: "local",
              source: "/tmp/foreign",
            },
          },
        ],
        installed: [],
        mcpAuth: {},
      })}\n`,
    );

    await assert.rejects(
      installCurrentProfile("dev", {
        repoRoot,
        buildRoot,
        codexHome,
        codexBin: fakeCodexBin,
        env: {
          ...process.env,
          FAKE_CODEX_STATE: statePath,
          FAKE_CODEX_LOG: logPath,
          FAKE_EXPECT_CODEX_HOME: codexHome,
        },
      }),
      /foreign marketplace named nuanu-dev/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("current-profile install keeps plugin-started OAuth native to Codex", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-current-plugin-oauth-"),
  );
  const codexHome = path.join(tempRoot, "codex-home");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "commands.jsonl");
  let wrapperBrowserOpenAttempts = 0;

  try {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        marketplaces: [],
        installed: [],
        mcpAuth: {},
      })}\n`,
    );

    await installCurrentProfile("dev", {
      repoRoot,
      buildRoot,
      codexHome,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
        FAKE_EXPECT_CODEX_HOME: codexHome,
        FAKE_PLUGIN_ADD_OAUTH: "1",
      },
      openBrowser() {
        wrapperBrowserOpenAttempts += 1;
        return true;
      },
    });

    assert.equal(wrapperBrowserOpenAttempts, 0);
    const commands = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      commands.filter((args) => args[0] === "mcp" && args[1] === "login")
        .length,
      0,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("current-profile production install uses the canonical marketplace and native browser OAuth", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-current-production-"),
  );
  const codexHome = path.join(tempRoot, "codex-home");
  const statePath = path.join(tempRoot, "state.json");
  const logPath = path.join(tempRoot, "commands.jsonl");
  let wrapperBrowserOpenAttempts = 0;

  try {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        marketplaces: [],
        installed: [],
        mcpAuth: {},
      })}\n`,
    );

    const report = await installCurrentProfile("prod", {
      repoRoot,
      codexHome,
      codexBin: fakeCodexBin,
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
        FAKE_EXPECT_CODEX_HOME: codexHome,
      },
      openBrowser() {
        wrapperBrowserOpenAttempts += 1;
        return true;
      },
    });

    assert.equal(report.pluginId, "nuanu-flow@nuanu");
    assert.equal(report.mcpUrl, "https://flow.nuanu.com/mcp-server/mcp");
    assert.equal(report.authStatus, "o_auth");
    assert.equal(report.hookStatus, "review_required");
    assert.equal(
      report.resumeCommand,
      'codex resume --last "Continue Nuanu Flow setup"',
    );
    assert.equal(wrapperBrowserOpenAttempts, 0);
    const state = await readJson(statePath);
    assert.equal(state.marketplaces[0].name, "nuanu");
    assert.equal(state.installed[0].pluginId, "nuanu-flow@nuanu");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
