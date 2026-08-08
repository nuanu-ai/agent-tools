#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = "https://flow.nuanu.com/api";
const ENROLLMENT_TOKEN_PATTERN = /^nuanu_join_[0-9a-f]{64}$/;
const AGENT_KEY_PATTERN = /^nuanu_flow_[0-9a-f]{64}$/;
const SECRET_PATTERN = /nuanu_(?:join|flow)_[0-9a-f]{64}/g;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_LOCK_SECONDS = 300;
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

let activeChild = null;
let running = true;

function redact(value) {
  return String(value ?? "").replaceAll(SECRET_PATTERN, "[redacted]");
}

function log(message) {
  process.stderr.write(`[nuanu-portable-worker] ${redact(message)}\n`);
}

function isLoopback(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function normalizeApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid API base URL");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.replace(/\/+$/, "").endsWith("/api")
  ) {
    throw new Error(
      "API base URL must use HTTPS, or loopback HTTP for local development, and end in /api",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function environmentFor(baseUrl) {
  return isLoopback(new URL(baseUrl).hostname) ? "local" : "production";
}

export function credentialPathForBase(
  baseUrl,
  {
    env = process.env,
    homeDirectory = os.homedir(),
  } = {},
) {
  const configRoot =
    env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
  const originHash = createHash("sha256")
    .update(normalizeApiBase(baseUrl))
    .digest("hex")
    .slice(0, 24);
  return path.join(
    configRoot,
    "nuanu-flow",
    "portable-workers",
    `${originHash}.json`,
  );
}

function enrollmentFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function readCredential(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error("Stored worker credential is not valid JSON");
  }
  if (
    !record ||
    normalizeApiBase(record.baseUrl) !== record.baseUrl ||
    !AGENT_KEY_PATTERN.test(record.agentKey ?? "") ||
    typeof record.agent?.id !== "string" ||
    typeof record.agent?.display_name !== "string" ||
    typeof record.agent?.workspace !== "string"
  ) {
    throw new Error("Stored worker credential is invalid");
  }
  return record;
}

async function writeCredential(filePath, record) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
  const mode = (await stat(filePath)).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error("Worker credential permissions are not private");
  }
}

async function requestJson(
  baseUrl,
  route,
  {
    method = "GET",
    body,
    agentKey,
    operation = "Request",
    retries = 0,
  } = {},
) {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(agentKey ? { "X-Agent-Key": agentKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        // Never echo a raw response because a bad deployment could include
        // credentials in it.
      }
      if (!response.ok) {
        const error = new Error(
          `${operation} failed (HTTP ${response.status})`,
        );
        error.status = response.status;
        if (
          response.status >= 500 &&
          attempt < retries
        ) {
          attempt += 1;
          await sleep(Math.min(250 * 2 ** attempt, 2_000));
          continue;
        }
        throw error;
      }
      return data;
    } catch (error) {
      if (
        error?.status === undefined &&
        attempt < retries
      ) {
        attempt += 1;
        await sleep(Math.min(250 * 2 ** attempt, 2_000));
        continue;
      }
      throw error;
    }
  }
}

async function verifyCredential(record) {
  const identity = await requestJson(
    record.baseUrl,
    "/agent-worker/whoami/",
    {
      agentKey: record.agentKey,
      operation: "Agent verification",
      retries: 1,
    },
  );
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
  credentialFile,
}) {
  if (!ENROLLMENT_TOKEN_PATTERN.test(enrollmentToken ?? "")) {
    throw new Error("Invalid enrollment token");
  }
  const normalizedBase = normalizeApiBase(baseUrl);
  const filePath =
    credentialFile || credentialPathForBase(normalizedBase);
  const fingerprint = enrollmentFingerprint(enrollmentToken);
  const existing = await readCredential(filePath);
  if (
    existing?.baseUrl === normalizedBase &&
    existing.enrollmentTokenSha256 === fingerprint
  ) {
    const agent = await verifyCredential(existing);
    return {
      status: "already_enrolled",
      environment: environmentFor(normalizedBase),
      agent,
    };
  }

  const data = await requestJson(
    normalizedBase,
    "/agent-worker/enroll/",
    {
      method: "POST",
      body: { enrollment_token: enrollmentToken },
      operation: "Enrollment",
    },
  );
  if (
    !AGENT_KEY_PATTERN.test(data.agent_key ?? "") ||
    typeof data.agent?.id !== "string" ||
    typeof data.agent?.display_name !== "string" ||
    typeof data.agent?.workspace !== "string"
  ) {
    throw new Error("Enrollment response is missing required fields");
  }
  const returnedBase = normalizeApiBase(data.api_url ?? normalizedBase);
  if (returnedBase !== normalizedBase) {
    throw new Error("Enrollment response returned an unexpected API origin");
  }
  const record = {
    baseUrl: normalizedBase,
    agentKey: data.agent_key,
    enrollmentTokenSha256: fingerprint,
    agent: {
      id: data.agent.id,
      display_name: data.agent.display_name,
      workspace: data.agent.workspace,
    },
  };
  const agent = await verifyCredential(record);
  await writeCredential(filePath, record);
  return {
    status: "enrolled",
    environment: environmentFor(normalizedBase),
    agent,
  };
}

async function resolveCredential({
  baseUrl,
  credentialFile,
  env = process.env,
}) {
  const normalizedBase = normalizeApiBase(
    baseUrl || env.NUANU_URL || DEFAULT_API_BASE,
  );
  if (env.NUANU_AGENT_KEY) {
    if (!AGENT_KEY_PATTERN.test(env.NUANU_AGENT_KEY)) {
      throw new Error("NUANU_AGENT_KEY has an invalid format");
    }
    const identity = await requestJson(
      normalizedBase,
      "/agent-worker/whoami/",
      {
        agentKey: env.NUANU_AGENT_KEY,
        operation: "Agent verification",
      },
    );
    return {
      baseUrl: normalizedBase,
      agentKey: env.NUANU_AGENT_KEY,
      agent: {
        id: identity.agent_id,
        display_name: identity.display_name,
        workspace: identity.workspace,
      },
    };
  }
  const filePath =
    credentialFile || credentialPathForBase(normalizedBase, { env });
  const record = await readCredential(filePath);
  if (!record) {
    throw new Error(
      "No portable worker credential found; run enroll first",
    );
  }
  if (record.baseUrl !== normalizedBase) {
    throw new Error("Stored worker credential belongs to another API origin");
  }
  return record;
}

export async function status(options = {}) {
  const record = await resolveCredential(options);
  const agent = await verifyCredential(record);
  return {
    status: "connected",
    environment: environmentFor(record.baseUrl),
    agent,
  };
}

function buildPrompt(task) {
  const parts = [];
  if (task.system_prompt) parts.push(String(task.system_prompt).trim());
  if (task.instruction) parts.push(String(task.instruction).trim());
  if (task.context && Object.keys(task.context).length) {
    parts.push(
      `--- Process context ---\n${JSON.stringify(task.context, null, 2)}`,
    );
  }
  if (task.output_schema) {
    parts.push(
      `Return ONLY a JSON object matching this schema (no prose):\n${JSON.stringify(task.output_schema)}`,
    );
  }
  return parts.join("\n\n");
}

function taskEnvironment(task, source = process.env) {
  if (!AGENT_KEY_PATTERN.test(task.agent_key ?? "")) {
    throw new Error("Remote task is missing a valid task-scoped agent key");
  }
  const env = { ...source };
  for (const name of [
    "NUANU_TOKEN",
    "NUANU_DEV_TOKEN",
    "NUANU_AGENT_KEY",
    "NUANU_DEV_AGENT_KEY",
  ]) {
    delete env[name];
  }
  env.NUANU_AGENT_KEY = task.agent_key;
  return env;
}

function runCommand(
  command,
  task,
  {
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      env: taskEnvironment(task),
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        code: -1,
        stdout,
        stderr: `${stderr}\ncommand timed out`,
      });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        code: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
      });
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.end(buildPrompt(task));
  });
}

async function postControl(record, route, body, operation) {
  return requestJson(record.baseUrl, route, {
    method: "POST",
    body,
    agentKey: record.agentKey,
    operation,
    retries: 2,
  });
}

async function handleTask(record, workerId, command, task, timeoutMs) {
  const result = await runCommand(command, task, { timeoutMs });
  if (result.code === 0) {
    const output = result.stdout.trim();
    if (!output) {
      await postControl(
        record,
        `/agent-worker/tasks/${task.task_id}/fail/`,
        {
          worker_id: workerId,
          error: "Portable agent command returned no output",
          requeue: true,
        },
        "Task requeue",
      );
      return "requeued";
    }
    await postControl(
      record,
      `/agent-worker/tasks/${task.task_id}/complete/`,
      {
        status: "ok",
        worker_id: workerId,
        output,
      },
      "Task completion",
    );
    return "completed";
  }
  await postControl(
    record,
    `/agent-worker/tasks/${task.task_id}/fail/`,
    {
      worker_id: workerId,
      error: redact(
        `Portable agent command exited ${result.code}: ${result.stderr}`,
      ).slice(0, 2_000),
      requeue: true,
    },
    "Task requeue",
  );
  return "requeued";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runWorker({
  baseUrl,
  credentialFile,
  command,
  once = false,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  lockSeconds = DEFAULT_LOCK_SECONDS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  env = process.env,
}) {
  if (!command?.trim()) {
    throw new Error(
      "run requires --command with a non-interactive text-in/text-out command",
    );
  }
  const record = await resolveCredential({
    baseUrl,
    credentialFile,
    env,
  });
  await verifyCredential(record);
  const workerId =
    env.NUANU_WORKER_ID ||
    `portable-${os.hostname()}-${process.pid}`;
  let nextHeartbeatAt = 0;

  do {
    const now = Date.now();
    if (now >= nextHeartbeatAt) {
      await postControl(
        record,
        "/agent-worker/heartbeat/",
        { worker_id: workerId },
        "Heartbeat",
      );
      nextHeartbeatAt = now + heartbeatIntervalMs;
      log(
        `connected to ${environmentFor(record.baseUrl)} as ${record.agent.display_name}`,
      );
    }
    const response = await postControl(
      record,
      "/agent-worker/tasks/fetch-and-lock/",
      {
        worker_id: workerId,
        max_tasks: 1,
        lock_seconds: lockSeconds,
      },
      "Task claim",
    );
    const task = Array.isArray(response.tasks) ? response.tasks[0] : null;
    if (task) {
      const outcome = await handleTask(
        record,
        workerId,
        command,
        task,
        commandTimeoutMs,
      );
      log(`${outcome} task ${String(task.task_id).slice(0, 12)}`);
    }
    if (!once && running) await sleep(Math.max(500, pollIntervalMs));
  } while (!once && running);

  return {
    status: running ? "stopped" : "shutdown",
    environment: environmentFor(record.baseUrl),
    agent: record.agent,
  };
}

function parseInteger(value, label, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const commandName = argv[0];
  if (!["enroll", "status", "run"].includes(commandName)) {
    throw new Error(
      "Usage: worker.mjs <enroll|status|run> [options]",
    );
  }
  const options = {
    commandName,
    baseUrl: DEFAULT_API_BASE,
    once: false,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    lockSeconds: DEFAULT_LOCK_SECONDS,
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === "--base-url") options.baseUrl = next();
    else if (argument === "--credential-file") {
      options.credentialFile = path.resolve(next());
    } else if (argument === "--command" && commandName === "run") {
      options.command = next();
    } else if (argument === "--once" && commandName === "run") {
      options.once = true;
    } else if (argument === "--poll-interval-ms" && commandName === "run") {
      options.pollIntervalMs = parseInteger(
        next(),
        "--poll-interval-ms",
        500,
      );
    } else if (
      argument === "--heartbeat-interval-ms" &&
      commandName === "run"
    ) {
      options.heartbeatIntervalMs = parseInteger(
        next(),
        "--heartbeat-interval-ms",
        5_000,
      );
    } else if (argument === "--lock-seconds" && commandName === "run") {
      options.lockSeconds = parseInteger(
        next(),
        "--lock-seconds",
        30,
      );
    } else if (
      argument === "--command-timeout-ms" &&
      commandName === "run"
    ) {
      options.commandTimeoutMs = parseInteger(
        next(),
        "--command-timeout-ms",
        10_000,
      );
    } else {
      // Do not echo an unknown argument: it may be a mistakenly supplied
      // enrollment token.
      throw new Error("Unknown option");
    }
  }
  options.baseUrl = normalizeApiBase(options.baseUrl);
  return options;
}

async function readEnrollmentToken() {
  process.stderr.write("Enrollment token: ");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stderr.write("\n");
  return input.trim();
}

function shutdown(signal) {
  if (!running) return;
  running = false;
  log(`received ${signal}; stopping`);
  if (activeChild && activeChild.exitCode == null) {
    activeChild.kill(signal);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.commandName === "enroll") {
    const result = await enroll({
      baseUrl: options.baseUrl,
      enrollmentToken: await readEnrollmentToken(),
      credentialFile: options.credentialFile,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (options.commandName === "status") {
    const result = await status(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  await runWorker(options);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      (await realpath(process.argv[1])) ===
      (await realpath(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  main().catch((error) => {
    process.stderr.write(
      `[nuanu-portable-worker] ${redact(error.message)}\n`,
    );
    process.exitCode = 1;
  });
}
