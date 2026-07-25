#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { createDefaultCredentialStore } from "./credentials.mjs";

const DEFAULT_API_BASE = "https://flow.nuanu.com/api";
const ENROLLMENT_TOKEN_PATTERN = /^nuanu_join_[0-9a-f]{64}$/;
const AGENT_KEY_PATTERN = /^nuanu_flow_[0-9a-f]{64}$/;

function normalizeApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid API base URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.replace(/\/+$/, "").endsWith("/api")
  ) {
    throw new Error("API base URL must be HTTPS and end in /api");
  }
  return url.toString().replace(/\/+$/, "");
}

async function readJson(response, operation) {
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Error responses are intentionally not echoed because they may contain
    // credentials in a misconfigured deployment.
  }
  if (!response.ok) {
    const error = new Error(`${operation} failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function verifyCredential(record, fetchImpl) {
  const response = await fetchImpl(`${record.baseUrl}/agent-worker/whoami/`, {
    method: "GET",
    headers: {
      "X-Agent-Key": record.agentKey,
    },
  });
  const identity = await readJson(response, "Agent verification");
  if (
    identity.agent_id !== record.agent.id ||
    identity.workspace !== record.agent.workspace ||
    identity.is_active === false
  ) {
    throw new Error("Agent verification returned an unexpected identity");
  }
  return {
    id: identity.agent_id,
    display_name: identity.display_name,
    workspace: identity.workspace,
  };
}

export async function enroll({
  baseUrl = DEFAULT_API_BASE,
  enrollmentToken,
  credentialStore = createDefaultCredentialStore(),
  fetchImpl = globalThis.fetch,
}) {
  if (!ENROLLMENT_TOKEN_PATTERN.test(enrollmentToken ?? "")) {
    throw new Error("Invalid enrollment token");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch");
  }

  const normalizedBase = normalizeApiBase(baseUrl);
  const existing = await credentialStore.load();
  if (existing) {
    const agent = await verifyCredential(existing, fetchImpl);
    return { status: "already_enrolled", agent };
  }

  const response = await fetchImpl(`${normalizedBase}/agent-worker/enroll/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enrollment_token: enrollmentToken }),
  });
  const data = await readJson(response, "Enrollment");
  if (
    !AGENT_KEY_PATTERN.test(data.agent_key ?? "") ||
    !data.agent ||
    typeof data.agent.id !== "string" ||
    typeof data.agent.display_name !== "string" ||
    typeof data.agent.workspace !== "string"
  ) {
    throw new Error("Enrollment response is missing required fields");
  }

  const record = {
    baseUrl: normalizeApiBase(data.api_url ?? normalizedBase),
    agentKey: data.agent_key,
    agent: {
      id: data.agent.id,
      display_name: data.agent.display_name,
      workspace: data.agent.workspace,
    },
  };
  const agent = await verifyCredential(record, fetchImpl);
  await credentialStore.save(record);
  return { status: "enrolled", agent };
}

function parseArgs(argv) {
  let baseUrl = DEFAULT_API_BASE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base-url") {
      baseUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { baseUrl };
}

async function readEnrollmentToken() {
  process.stderr.write("Enrollment token: ");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stderr.write("\n");
  return input.trim();
}

async function main() {
  try {
    const { baseUrl } = parseArgs(process.argv.slice(2));
    const enrollmentToken = await readEnrollmentToken();
    const result = await enroll({ baseUrl, enrollmentToken });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`[nuanu-enroll] ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
