import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readHookTrustStatus } from "../../scripts/codex/hook-status.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fakeCodexBin = path.join(repoRoot, "tests/fixtures/fake-codex.mjs");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-hook-status-"));
  const statePath = path.join(root, "state.json");
  const logPath = path.join(root, "commands.jsonl");
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      marketplaces: [],
      installed: [
        {
          pluginId: "nuanu-flow-dev@nuanu-dev",
          name: "nuanu-flow-dev",
          marketplaceName: "nuanu-dev",
          version: "0.3.0",
          installed: true,
          enabled: true,
        },
      ],
      mcpAuth: { "nuanu-flow": "o_auth" },
    })}\n`,
  );
  return { root, statePath, logPath };
}

async function readStatus(env) {
  return readHookTrustStatus({
    codexBin: fakeCodexBin,
    cwd: repoRoot,
    env,
    pluginId: "nuanu-flow-dev@nuanu-dev",
    timeoutMs: 2_000,
  });
}

test("hook doctor distinguishes review, trusted, and disabled states", async () => {
  const { root, statePath, logPath } = await fixture();
  try {
    const base = {
      ...process.env,
      FAKE_CODEX_STATE: statePath,
      FAKE_CODEX_LOG: logPath,
    };
    assert.equal((await readStatus(base)).status, "review_required");
    assert.equal(
      (
        await readStatus({
          ...base,
          FAKE_HOOK_TRUST: "trusted",
        })
      ).status,
      "trusted",
    );
    assert.equal(
      (
        await readStatus({
          ...base,
          FAKE_HOOK_TRUST: "trusted",
          FAKE_HOOK_DISABLED: "1",
        })
      ).status,
      "review_required",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("hook doctor fails open when discovery is unavailable", async () => {
  const { root, statePath, logPath } = await fixture();
  try {
    const base = {
      ...process.env,
      FAKE_CODEX_STATE: statePath,
      FAKE_CODEX_LOG: logPath,
    };
    const unsupported = await readStatus({
      ...base,
      FAKE_HOOKS_UNSUPPORTED: "1",
    });
    assert.equal(unsupported.status, "unsupported");
    assert.match(unsupported.detail, /hooks\/list unsupported/);

    const missing = await readStatus({
      ...base,
      FAKE_HOOKS_EMPTY: "1",
    });
    assert.equal(missing.status, "unsupported");
    assert.match(missing.detail, /not discovered/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
