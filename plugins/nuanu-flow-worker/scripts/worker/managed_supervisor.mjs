#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDirectory = process.env.NUANU_WORKER_STATE_DIR || path.join(os.homedir(), ".nuanu-flow-worker");
const statePath = path.join(stateDirectory, "managed-supervisor-v1.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const result = { command: argv[0] || "", values: {} };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error("invalid managed supervisor arguments");
    result.values[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function readState() {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeState(value) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

function required(values, name) {
  const value = String(values[name] || "").trim();
  if (!value || value.includes("\0")) throw new Error(`missing ${name}`);
  return value;
}

function optional(values, name) {
  const value = String(values[name] || "").trim();
  if (value.includes("\0")) throw new Error(`invalid ${name}`);
  return value;
}

async function start(values) {
  const existing = await readState();
  if (existing && processAlive(Number(existing.monitor_pid))) {
    process.stdout.write(`${JSON.stringify({ status: "running", monitor_pid: existing.monitor_pid })}\n`);
    return;
  }
  const workerScript = required(values, "worker-script");
  const busScript = required(values, "bus-script");
  const adapter = required(values, "adapter");
  const workerId = required(values, "worker-id");
  const internalMcpHostname = optional(values, "internal-mcp-hostname");
  const monitorArgs = [
    new URL(import.meta.url).pathname,
    "monitor",
    "--worker-script",
    workerScript,
    "--bus-script",
    busScript,
    "--adapter",
    adapter,
    "--worker-id",
    workerId,
  ];
  if (internalMcpHostname) monitorArgs.push("--internal-mcp-hostname", internalMcpHostname);
  const monitor = spawn(process.execPath, monitorArgs, { detached: true, stdio: "ignore", env: process.env });
  monitor.unref();
  await writeState({ schema_version: 1, monitor_pid: monitor.pid, worker_pid: null, status: "starting" });
  process.stdout.write(`${JSON.stringify({ status: "starting", monitor_pid: monitor.pid })}\n`);
}

async function monitor(values) {
  const workerScript = required(values, "worker-script");
  const busScript = required(values, "bus-script");
  const adapter = required(values, "adapter");
  const workerId = required(values, "worker-id");
  const internalMcpHostname = optional(values, "internal-mcp-hostname");
  let running = true;
  let child = null;
  const stop = () => {
    running = false;
    if (child && processAlive(child.pid)) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    child = spawn(process.execPath, [workerScript], {
      stdio: "ignore",
      env: {
        ...process.env,
        NUANU_ADAPTER: adapter,
        NUANU_AGENT_BUS_SCRIPT: busScript,
        NUANU_WORKER_ID: workerId,
        ...(internalMcpHostname ? { NUANU_INTERNAL_MCP_HOSTNAME: internalMcpHostname } : {}),
      },
    });
    await writeState({
      schema_version: 1,
      monitor_pid: process.pid,
      worker_pid: child.pid,
      status: "running",
    });
    await new Promise((resolve) => child.once("exit", resolve));
    child = null;
    if (running) {
      await writeState({ schema_version: 1, monitor_pid: process.pid, worker_pid: null, status: "restarting" });
      await sleep(2_000);
    }
  }
  await rm(statePath, { force: true });
}

async function status() {
  const value = await readState();
  const running = Boolean(value && processAlive(Number(value.monitor_pid)));
  process.stdout.write(`${JSON.stringify({ status: running ? value.status || "running" : "stopped" })}\n`);
  if (!running) process.exitCode = 1;
}

async function stop() {
  const value = await readState();
  if (value && processAlive(Number(value.monitor_pid))) process.kill(Number(value.monitor_pid), "SIGTERM");
  await rm(statePath, { force: true });
  process.stdout.write(`${JSON.stringify({ status: "stopped" })}\n`);
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.command === "start") await start(parsed.values);
else if (parsed.command === "monitor") await monitor(parsed.values);
else if (parsed.command === "status") await status();
else if (parsed.command === "stop") await stop();
else throw new Error("expected start, monitor, status, or stop");
