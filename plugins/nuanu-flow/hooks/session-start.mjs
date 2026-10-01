#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { connectionAt, contextPointer } from "../scripts/context/context.mjs";

const VALID_SOURCES = new Set(["startup", "resume", "clear", "compact"]);

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

export function acceptsSession(payload) {
  if (payload?.hook_event_name !== "SessionStart" || !VALID_SOURCES.has(payload?.source)) {
    return false;
  }
  return true;
}

export async function sessionStartOutput(
  payload,
  { connection, principal = process.env.NUANU_FLOW_PRINCIPAL_ID } = {}
) {
  if (!acceptsSession(payload)) return "";
  const registeredConnection = connection ?? (await connectionAt());
  const additionalContext = await contextPointer({
    cwd: payload.cwd,
    connection: registeredConnection,
    principal,
    session: payload.session_id,
  });
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  })}\n`;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  try {
    const output = await sessionStartOutput(payload);
    if (output) process.stdout.write(output);
  } catch {
    // Hooks must fail open. The native MCP remains the source of truth.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
