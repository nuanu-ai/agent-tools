#!/usr/bin/env node

import {
  repositoryContextMessage,
  resolveRepositoryContext,
} from "./repository-context.mjs";

const VALID_SOURCES = new Set(["startup", "clear", "compact"]);

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

function isSupportedEvent(payload) {
  return (
    payload?.hook_event_name === "SessionStart" &&
    VALID_SOURCES.has(payload?.source)
  );
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!isSupportedEvent(payload)) return;
  const binding = await resolveRepositoryContext(payload.cwd);
  const additionalContext = repositoryContextMessage(binding);
  if (!additionalContext) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    })}\n`,
  );
}

await main();
