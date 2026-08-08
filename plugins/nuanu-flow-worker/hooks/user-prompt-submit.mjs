#!/usr/bin/env node

import {
  activityContext,
  consumeSessionActivity,
} from "../scripts/activity/remote-worker-activity.mjs";

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (
    payload?.hook_event_name !== "UserPromptSubmit" ||
    typeof payload?.session_id !== "string"
  ) {
    return;
  }
  const events = await consumeSessionActivity({
    sessionId: payload.session_id,
  });
  const additionalContext = activityContext(events);
  if (!additionalContext) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    })}\n`,
  );
}

await main();
