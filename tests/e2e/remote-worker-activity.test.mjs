import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  activityContext,
  activityInternals,
  consumeSessionActivity,
  createActivityStore,
} from "../../plugins/nuanu-flow/scripts/activity/remote-worker-activity.mjs";
import {
  createWorkerActivity,
  renderActivity,
  safeTaskTitle,
} from "../../plugins/nuanu-flow/scripts/worker/activity.mjs";
import {
  classifyAppServerActivity,
} from "../../plugins/nuanu-flow/scripts/worker/app_server_client.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const userPromptHook = path.join(
  repoRoot,
  "plugins/nuanu-flow/hooks/user-prompt-submit.mjs",
);

function runHook(script, payload, activityDirectory) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: {
      ...process.env,
      NUANU_ACTIVITY_DATA_DIR: activityDirectory,
    },
  });
}

function promptPayload(sessionId) {
  return {
    session_id: sessionId,
    transcript_path: null,
    cwd: repoRoot,
    hook_event_name: "UserPromptSubmit",
    turn_id: "turn-test",
    prompt: "What happened?",
    model: "test",
    permission_mode: "default",
  };
}

test("activity store keeps safe milestones private and consumes them once", async () => {
  const activityDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-activity-store-"),
  );
  const sessionId = "session-store-test";
  let nowMs = Date.UTC(2026, 6, 29, 9, 0, 0);
  const store = createActivityStore({
    activityDirectory,
    ownerSessionId: sessionId,
    now: () => nowMs++,
  });
  try {
    await store.publish({
      kind: "task.claimed",
      worker_id: "worker-1",
      agent_name: "Campaign Agent",
      task_id: "task-1",
      safe_title: `Launch campaign nuanu_flow_${"a".repeat(64)}`,
    });
    await store.publish({
      kind: "task.progress",
      worker_id: "worker-1",
      agent_name: "Campaign Agent",
      task_id: "task-1",
      safe_summary: `token=${"b".repeat(40)}`,
    });
    await store.publish({
      kind: "task.completed",
      worker_id: "worker-1",
      agent_name: "Campaign Agent",
      task_id: "task-1",
      safe_title: "Launch campaign",
      duration_ms: 102_000,
    });

    const sessionRoot = activityInternals.sessionDirectory(
      activityDirectory,
      sessionId,
    );
    const eventFiles = await fs.readdir(path.join(sessionRoot, "events"));
    const onDisk = (
      await Promise.all(
        eventFiles.map((name) =>
          fs.readFile(path.join(sessionRoot, "events", name), "utf8"),
        ),
      )
    ).join("");
    assert.doesNotMatch(onDisk, /nuanu_flow_/);
    assert.doesNotMatch(onDisk, new RegExp("b{20}"));
    assert.equal(
      (await fs.stat(path.join(sessionRoot, "events", eventFiles[0]))).mode &
        0o777,
      0o600,
    );

    const events = await consumeSessionActivity({
      sessionId,
      activityDirectory,
      now: () => nowMs,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "task.completed");
    assert.match(activityContext(events), /Campaign Agent completed/);
    assert.match(activityContext(events), /1m 42s/);
    assert.deepEqual(
      await consumeSessionActivity({
        sessionId,
        activityDirectory,
        now: () => nowMs,
      }),
      [],
    );
  } finally {
    await fs.rm(activityDirectory, { recursive: true, force: true });
  }
});

test("activity stays bound to the exact Codex session", async () => {
  const activityDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-activity-session-"),
  );
  const ownerSessionId = "session-owner";
  const otherSessionId = "session-other";
  const store = createActivityStore({
    activityDirectory,
    ownerSessionId,
  });
  try {
    await store.publish({
      kind: "task.attention",
      worker_id: "worker-1",
      agent_name: "Research Agent",
      task_id: "task-2",
      safe_title: "Approve sources",
      safe_summary: "The headless task requested user input",
    });
    assert.deepEqual(
      await consumeSessionActivity({
        sessionId: otherSessionId,
        activityDirectory,
      }),
      [],
    );
    const ownerEvents = await consumeSessionActivity({
      sessionId: ownerSessionId,
      activityDirectory,
    });
    assert.equal(ownerEvents.length, 1);
    assert.equal(ownerEvents[0].kind, "task.attention");
  } finally {
    await fs.rm(activityDirectory, { recursive: true, force: true });
  }
});

test("UserPromptSubmit provides bounded same-session catch-up after activity and reopen", async () => {
  const activityDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-activity-hook-"),
  );
  const sessionId = "session-hook-test";
  const store = createActivityStore({
    activityDirectory,
    ownerSessionId: sessionId,
  });
  try {
    await store.publish({
      kind: "task.completed",
      worker_id: "worker-1",
      agent_name: "Marketing Agent",
      task_id: "task-3",
      safe_title: "Create launch brief",
      duration_ms: 42_000,
    });
    let result = runHook(
      userPromptHook,
      promptPayload(sessionId),
      activityDirectory,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    let output = JSON.parse(result.stdout);
    assert.equal(
      output.hookSpecificOutput.hookEventName,
      "UserPromptSubmit",
    );
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /Marketing Agent completed “Create launch brief” in 42s/,
    );
    assert(
      output.hookSpecificOutput.additionalContext.trim().split(/\s+/).length <=
        60,
    );

    result = runHook(
      userPromptHook,
      promptPayload(sessionId),
      activityDirectory,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");

    await store.publish({
      kind: "task.requeued",
      worker_id: "worker-1",
      agent_name: "Marketing Agent",
      task_id: "task-4",
      safe_title: "Publish assets",
    });
    result = runHook(
      userPromptHook,
      promptPayload(sessionId),
      activityDirectory,
    );
    assert.equal(result.status, 0, result.stderr);
    output = JSON.parse(result.stdout);
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /Marketing Agent could not finish “Publish assets”; Flow requeued it/,
    );

    result = runHook(
      userPromptHook,
      promptPayload("different-session"),
      activityDirectory,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    await fs.rm(activityDirectory, { recursive: true, force: true });
  }
});

test("worker activity renderer is concise, deduplicated, and instruction-safe", async () => {
  const activityDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuanu-activity-render-"),
  );
  const lines = [];
  const activity = createWorkerActivity({
    config: {
      directory: activityDirectory,
      ownerSessionId: "session-render",
      workerId: "worker-render",
      agentName: "Codex Agent",
    },
    log: (line) => lines.push(line),
  });
  try {
    const taskTitle = safeTaskTitle({
      step_name: `Campaign password=${"x".repeat(40)}`,
      instruction: `never render nuanu_join_${"c".repeat(64)}`,
    });
    assert.doesNotMatch(taskTitle, /x{20}|nuanu_join_/);
    activity.emit({
      kind: "task.progress",
      task_id: "task-render",
      safe_summary: "Running a command",
    });
    activity.emit({
      kind: "task.progress",
      task_id: "task-render",
      safe_summary: "Running a command",
    });
    activity.emit({
      kind: "task.completed",
      task_id: "task-render",
      safe_title: "Campaign",
      duration_ms: 61_000,
    });
    await activity.flush();
    assert.deepEqual(lines, [
      "├ Running a command",
      "✓ Completed “Campaign” in 1m 1s",
    ]);
    assert.equal(
      renderActivity({ kind: "worker.connected" }),
      "● Remote agent connected",
    );
  } finally {
    await fs.rm(activityDirectory, { recursive: true, force: true });
  }
});

test("App Server activity classification excludes raw item content", () => {
  assert.deepEqual(
    classifyAppServerActivity({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          command: `echo nuanu_flow_${"a".repeat(64)}`,
        },
      },
    }),
    { kind: "task.progress", safe_summary: "Running a command" },
  );
  assert.deepEqual(
    classifyAppServerActivity({
      method: "item/tool/requestUserInput",
      params: { questions: [{ question: "secret prompt" }] },
    }),
    {
      kind: "task.attention",
      safe_summary: "The headless task requested user input",
    },
  );
  assert.equal(
    classifyAppServerActivity({
      method: "item/agentMessage/delta",
      params: { delta: "private reasoning" },
    }),
    null,
  );
});
