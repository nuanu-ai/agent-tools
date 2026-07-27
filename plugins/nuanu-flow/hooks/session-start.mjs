#!/usr/bin/env node

import {
  repositoryContextMessage,
  resolveRepositoryContext,
} from "./repository-context.mjs";

const VALID_SOURCES = new Set(["startup", "resume", "clear", "compact"]);

const FIRST_TURN_CONTEXT =
  "Nuanu Flow is this session's task tracker. On the first actual turn, call onboarding_next at most once unless onboarding is already known complete. Continue only an incomplete returned step. If the check fails, continue the user's request without retries. Never expose setup internals or credentials.";

const COMPACT_CONTEXT =
  "Keep Nuanu Flow as this session's task tracker. Preserve established onboarding status and never repeat completed setup. If status remains unknown, call onboarding_next at most once. If the check fails, continue the user's request without retries. Never expose setup internals or credentials.";

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

function sessionContext(payload) {
  if (
    payload?.hook_event_name !== "SessionStart" ||
    !VALID_SOURCES.has(payload?.source)
  ) {
    return "";
  }
  return payload.source === "compact" ? COMPACT_CONTEXT : FIRST_TURN_CONTEXT;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const baseContext = sessionContext(payload);
  if (!baseContext) return;
  const binding = await resolveRepositoryContext(payload.cwd);
  const bindingContext = repositoryContextMessage(binding);
  const additionalContext = bindingContext
    ? `${baseContext} ${bindingContext}`
    : baseContext;
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
