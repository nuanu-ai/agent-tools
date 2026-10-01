import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";

import { sessionStartOutput } from "./session-start.mjs";

let temporary;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-session-hook-"));
});

afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

const payload = (source = "startup") => ({
  hook_event_name: "SessionStart",
  source,
  cwd: temporary,
  session_id: "session_1",
});

test("session hook emits a bounded local pointer without triggering onboarding", async () => {
  const output = await sessionStartOutput(payload(), {
    connection: { environment: "local", mcp_url: "http://localhost:3001/mcp" },
  });
  const parsed = JSON.parse(output);
  const context = parsed.hookSpecificOutput.additionalContext;
  assert.match(context, /Nuanu Flow connection: local/);
  assert.match(context, /Authenticated identity\/context is unconfirmed/);
  assert.doesNotMatch(context, /onboarding_next|first actual turn|call onboarding/i);
});

test("session hook treats startup, resume, clear, and compact consistently", async () => {
  for (const source of ["startup", "resume", "clear", "compact"]) {
    assert.notEqual(
      await sessionStartOutput(payload(source), {
        connection: { environment: "production", mcp_url: "https://flow.nuanu.com/mcp-server/mcp" },
      }),
      ""
    );
  }
  assert.equal(await sessionStartOutput(payload("other"), { connection: {} }), "");
});
