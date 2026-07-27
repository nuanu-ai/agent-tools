import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { removeNuanuFlow } from "../../scripts/codex/remove.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fakeCodexBin = path.join(repoRoot, "tests/fixtures/fake-codex.mjs");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeState(file, state) {
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

function nuanuState(pluginId, marketplaceName) {
  return {
    marketplaces: [
      {
        name: marketplaceName,
        root: `/tmp/${marketplaceName}`,
        marketplaceSource: {
          sourceType: "local",
          source: `/tmp/${marketplaceName}`,
        },
      },
    ],
    installed: [
      {
        pluginId,
        name: pluginId.split("@")[0],
        marketplaceName,
      },
    ],
    mcpAuth: { "nuanu-flow": "o_auth" },
  };
}

test("removeNuanuFlow clears every Nuanu install surface and preserves base Codex state", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-remove-"));
  const codexHome = path.join(tempRoot, "codex-home");
  const modeRoot = path.join(codexHome, "nuanu-flow");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "commands.jsonl");
  const baseState = nuanuState("nuanu-flow@nuanu", "nuanu");
  const removedAccounts = [];
  const keychain = {
    async remove({ account }) {
      removedAccounts.push(account);
      return true;
    },
  };
  baseState.marketplaces.push({
    name: "other",
    root: "/tmp/other",
    marketplaceSource: { sourceType: "local", source: "/tmp/other" },
  });
  baseState.installed.push({
    pluginId: "other@other",
    name: "other",
    marketplaceName: "other",
  });

  try {
    await fs.mkdir(path.join(modeRoot, "prod"), { recursive: true });
    await fs.mkdir(path.join(modeRoot, "dev"), { recursive: true });
    await fs.mkdir(path.join(codexHome, "plugins/cache/nuanu"), {
      recursive: true,
    });
    await fs.mkdir(path.join(codexHome, "plugins/cache/nuanu-dev"), {
      recursive: true,
    });
    await fs.mkdir(buildRoot, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(codexHome, "auth.json"), '{"shared":true}\n');
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      `[hooks.state]

[hooks.state."nuanu-flow@nuanu:hooks/hooks.json:session_start:0:0"]
trusted_hash = "sha256:nuanu"

[hooks.state."other@other:hooks/hooks.json:session_start:0:0"]
trusted_hash = "sha256:other"
`,
    );
    await writeState(path.join(stateDir, "codex-home.json"), baseState);
    await writeState(
      path.join(stateDir, "prod.json"),
      nuanuState("nuanu-flow@nuanu", "nuanu"),
    );
    await writeState(
      path.join(stateDir, "dev.json"),
      nuanuState("nuanu-flow-dev@nuanu-dev", "nuanu-dev"),
    );

    const report = await removeNuanuFlow({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      keychain,
      env: {
        ...process.env,
        FAKE_CODEX_STATE_DIR: stateDir,
        FAKE_CODEX_LOG: logPath,
      },
    });

    assert.equal(report.dryRun, false);
    const cleanedBase = await readJson(path.join(stateDir, "codex-home.json"));
    assert.deepEqual(
      cleanedBase.installed.map((plugin) => plugin.pluginId),
      ["other@other"],
    );
    assert.deepEqual(
      cleanedBase.marketplaces.map((marketplace) => marketplace.name),
      ["other"],
    );
    assert.deepEqual(cleanedBase.mcpAuth, {});
    assert.deepEqual(
      (await readJson(path.join(stateDir, "prod.json"))).installed,
      [],
    );
    assert.deepEqual(
      (await readJson(path.join(stateDir, "prod.json"))).mcpAuth,
      {},
    );
    assert.deepEqual(
      (await readJson(path.join(stateDir, "dev.json"))).installed,
      [],
    );
    assert.deepEqual(
      (await readJson(path.join(stateDir, "dev.json"))).mcpAuth,
      {},
    );
    await fs.access(path.join(codexHome, "auth.json"));
    const config = await fs.readFile(
      path.join(codexHome, "config.toml"),
      "utf8",
    );
    assert.doesNotMatch(config, /sha256:nuanu/);
    assert.match(config, /sha256:other/);
    await assert.rejects(fs.access(modeRoot), { code: "ENOENT" });
    await assert.rejects(fs.access(buildRoot), { code: "ENOENT" });
    await assert.rejects(
      fs.access(path.join(codexHome, "plugins/cache/nuanu")),
      { code: "ENOENT" },
    );
    assert.deepEqual(removedAccounts, [
      "nuanu-flow-codex-prod",
      "nuanu-flow-codex-dev",
    ]);
    const commandLog = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      commandLog.filter(
        (args) =>
          args[0] === "mcp" &&
          args[1] === "logout" &&
          args[2] === "nuanu-flow",
      ).length,
      3,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("removeNuanuFlow dry-run leaves installations and generated files intact", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-remove-dry-"),
  );
  const codexHome = path.join(tempRoot, "codex-home");
  const modeRoot = path.join(codexHome, "nuanu-flow");
  const buildRoot = path.join(tempRoot, "codex-dev");
  const stateDir = path.join(tempRoot, "state");
  const logPath = path.join(tempRoot, "commands.jsonl");
  let keychainCalls = 0;

  try {
    await fs.mkdir(path.join(modeRoot, "prod"), { recursive: true });
    await fs.mkdir(path.join(modeRoot, "dev"), { recursive: true });
    await fs.mkdir(buildRoot, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    for (const [name, state] of [
      ["codex-home", nuanuState("nuanu-flow@nuanu", "nuanu")],
      ["prod", nuanuState("nuanu-flow@nuanu", "nuanu")],
      ["dev", nuanuState("nuanu-flow-dev@nuanu-dev", "nuanu-dev")],
    ]) {
      await writeState(path.join(stateDir, `${name}.json`), state);
    }

    const report = await removeNuanuFlow({
      repoRoot,
      codexHome,
      buildRoot,
      codexBin: fakeCodexBin,
      dryRun: true,
      keychain: {
        async remove() {
          keychainCalls += 1;
        },
      },
      env: {
        ...process.env,
        FAKE_CODEX_STATE_DIR: stateDir,
        FAKE_CODEX_LOG: logPath,
      },
    });

    assert.equal(report.dryRun, true);
    assert.equal(
      (await readJson(path.join(stateDir, "codex-home.json"))).installed[0]
        .pluginId,
      "nuanu-flow@nuanu",
    );
    await fs.access(modeRoot);
    await fs.access(buildRoot);
    assert.equal(keychainCalls, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
