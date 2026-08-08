#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createTaskLogStore } from "./diagnostic_log.mjs";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/;
const TERMINAL_PHASES = new Set(["task_completed", "task_failed"]);

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function defaultLogRoot(env) {
  return env.NUANU_WORKER_LOG_DIR || path.join(os.homedir(), ".cache", "nuanu-flow", "worker-logs");
}

async function workerIds(rootDir, configured) {
  if (configured) return IDENTIFIER.test(configured) ? [configured] : [];
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && IDENTIFIER.test(entry.name)).map((entry) => entry.name);
}

function formatRecord(record) {
  const details = [];
  if (record.attempt) {
    details.push(`attempt ${record.attempt}${record.max_attempts ? `/${record.max_attempts}` : ""}`);
  }
  if (record.status_code) details.push(`HTTP ${record.status_code}`);
  if (record.error_code) details.push(record.error_code);
  if (record.session_id) details.push(`session ${record.session_id}`);
  if (record.turn_id) details.push(`turn ${record.turn_id}`);
  if (record.safe_message) details.push(record.safe_message);
  return `${record.occurred_at} ${record.phase.replaceAll("_", " ")}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

async function storesForTask(rootDir, configuredWorkerId, taskId) {
  const matches = [];
  for (const workerId of await workerIds(rootDir, configuredWorkerId)) {
    const store = createTaskLogStore({ rootDir, workerId });
    const records = await store.read({ taskId });
    if (records.length) matches.push({ workerId, store, records });
  }
  return matches;
}

async function runLogs(argv, { env, stdout, stderr, signal }) {
  const rootDir = defaultLogRoot(env);
  const taskId = optionValue(argv, "--task");
  const destination = optionValue(argv, "--export");
  const follow = argv.includes("--follow");
  if ((argv.includes("--task") && !taskId) || (argv.includes("--export") && !destination)) {
    stderr.write("nuanu-worker logs: missing option value\n");
    return 1;
  }

  if (!taskId) {
    let count = 0;
    for (const workerId of await workerIds(rootDir, env.NUANU_WORKER_ID)) {
      const store = createTaskLogStore({ rootDir, workerId });
      for (const item of await store.list()) {
        stdout.write(`${workerId} ${item.task_id} ${item.updated_at}\n`);
        count += 1;
      }
    }
    if (!count) stdout.write("No remote worker task logs found.\n");
    return 0;
  }

  let matches;
  try {
    matches = await storesForTask(rootDir, env.NUANU_WORKER_ID, taskId);
  } catch (error) {
    stderr.write(`nuanu-worker logs: ${error.message}\n`);
    return 1;
  }
  if (matches.length === 0) {
    stderr.write(`nuanu-worker logs: no journal found for task ${taskId}\n`);
    return 1;
  }
  if (matches.length > 1 && !env.NUANU_WORKER_ID) {
    stderr.write("nuanu-worker logs: task exists under multiple workers; set NUANU_WORKER_ID\n");
    return 1;
  }
  const [{ workerId, store, records }] = matches;
  stdout.write(`Worker ${workerId} · Task ${taskId}\n`);
  for (const record of records) stdout.write(`${formatRecord(record)}\n`);

  if (destination) {
    try {
      await store.export({ taskId, destination: path.resolve(destination) });
      stdout.write(`Exported sanitized diagnostics to ${path.resolve(destination)}\n`);
    } catch (error) {
      stderr.write(`nuanu-worker logs: ${error.message}\n`);
      return 1;
    }
  }

  if (follow && !TERMINAL_PHASES.has(records.at(-1)?.phase)) {
    for await (const record of store.follow({ taskId, after: records.length, signal })) {
      stdout.write(`${formatRecord(record)}\n`);
    }
  }
  return 0;
}

export async function runWorkerCli(
  argv,
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    signal,
    importWorker = () => import("./worker.mjs"),
  } = {}
) {
  if (argv[0] === "logs") return runLogs(argv.slice(1), { env, stdout, stderr, signal });
  await importWorker();
  return 0;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  runWorkerCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[nuanu-worker] ${error.message}`);
      process.exitCode = 1;
    }
  );
}
