#!/usr/bin/env node
/**
 * Universal remote-agent worker for Nuanu Flow.
 *
 * Loop: heartbeat (presence) + fetch-and-lock (claim up to free capacity) ->
 * adapter.handle(task) -> complete / fail. Everything agent-specific lives behind
 * the adapter; the loop is agent-agnostic. See docs/REMOTE_AGENTS.md.
 */
import { loadConfig } from "./config.mjs";
import { NuanuClient } from "./client.mjs";
import { makeAdapter } from "./adapter.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const cfg = loadConfig();
const client = new NuanuClient(cfg.baseUrl, cfg.agentKey);
const adapter = makeAdapter(cfg.adapter);

let running = true;
let inFlight = 0;

let heartbeatOk = false;

async function heartbeatLoop() {
  while (running) {
    try {
      await client.heartbeat(cfg.workerId);
      if (!heartbeatOk) {
        heartbeatOk = true;
        // Positive signal for launchers (e.g. /nuanu-flow:launch-remote-agent)
        // and for humans watching the log: the token is live and the platform
        // now shows this agent as online.
        log("remote agent connected — heartbeat OK");
      }
    } catch (e) {
      heartbeatOk = false;
      log("heartbeat failed:", e.message);
    }
    await sleep(cfg.heartbeatIntervalMs);
  }
}

async function handleTask(task) {
  const label = `${String(task.task_id).slice(0, 8)} ${task.step_id}`;
  log("claimed", label, "-", (task.instruction || "").slice(0, 70));
  try {
    const result = await adapter.handle(task);
    if (result.status === "ok") {
      await client.complete(task.task_id, { output: result.output, options: result.options, workerId: cfg.workerId });
      const runId = result.meta?.session_id || result.meta?.thread_id;
      log("completed", label, runId ? `(session ${String(runId).slice(0, 8)})` : "");
    } else {
      // The agent ran but reported an error -> terminal error signal to the engine.
      await client.completeError(task.task_id, result.error, cfg.workerId);
      log("completed-with-error", label, "-", String(result.error).slice(0, 140));
    }
  } catch (e) {
    // The worker/adapter itself failed -> requeue for another attempt.
    log("worker error on", label, "-", e.message, "-> requeue");
    try {
      await client.fail(task.task_id, { error: e.message, requeue: true, workerId: cfg.workerId });
    } catch (e2) {
      log("fail() also errored:", e2.message);
    }
  }
}

let pumping = false;

// Claim + dispatch all available tasks up to free capacity. Serialized so a poll
// tick and a gateway wake can't double-fetch (fetch-and-lock is already safe via
// SKIP LOCKED; this just keeps in-flight accounting clean).
async function pumpOnce() {
  if (pumping) return;
  pumping = true;
  try {
    while (running) {
      const free = cfg.maxConcurrency - inFlight;
      if (free <= 0) break;
      let tasks = [];
      try {
        const res = await client.fetchAndLock({
          workerId: cfg.workerId,
          maxTasks: free,
          lockSeconds: cfg.lockSeconds,
        });
        tasks = res.tasks || [];
      } catch (e) {
        // 401 is expected while the agent's token isn't live yet (the create
        // form pregenerates it) or was revoked — keep polling either way.
        if (e.status === 401) log("fetch-and-lock unauthorized — token not active yet or revoked; retrying");
        else log("fetch-and-lock failed:", e.message);
        break;
      }
      if (!tasks.length) break;
      for (const task of tasks) {
        inFlight++;
        handleTask(task).finally(() => {
          inFlight--;
        });
      }
      await sleep(100);
    }
  } finally {
    pumping = false;
  }
}

async function pollLoop() {
  // In gateway mode the WS wake drives delivery; polling is just a slow fallback.
  const interval = cfg.transport === "gateway" ? Math.max(cfg.pollIntervalMs, 15000) : cfg.pollIntervalMs;
  while (running) {
    await pumpOnce();
    await sleep(interval);
  }
}

// Phase-2 transport: dial the WS gateway and fetch on wake. Reconnects with a
// fixed backoff. Uses Node's built-in WebSocket (no dependency).
async function gatewayLoop() {
  if (cfg.transport !== "gateway") return;
  while (running) {
    // Mint a fresh single-use ticket over HTTPS (durable key in a header) and put only
    // that ephemeral ticket in the WS URL — never the durable agent key.
    let ticket;
    try {
      ({ ticket } = await client.wsTicket());
    } catch (e) {
      log("ws-ticket failed:", e.message);
      if (running) await sleep(3000);
      continue;
    }
    await new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(`${cfg.gatewayUrl}?ticket=${encodeURIComponent(ticket)}`);
      } catch (e) {
        log("gateway connect error:", e.message);
        return resolve();
      }
      const ping = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* not open */
        }
      }, 25000);
      const done = () => {
        clearInterval(ping);
        resolve();
      };
      ws.addEventListener("open", () => {
        log("gateway connected");
        pumpOnce();
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "task" || msg.type === "connected") pumpOnce();
      });
      ws.addEventListener("close", () => {
        log("gateway disconnected");
        done();
      });
      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        done();
      });
    });
    if (running) await sleep(3000);
  }
}

function shutdown(sig) {
  if (!running) return;
  log(`received ${sig}; draining ${inFlight} in-flight task(s)...`);
  running = false;
  const started = Date.now();
  const timer = setInterval(() => {
    if (inFlight === 0 || Date.now() - started > 30000) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 250);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("nuanu-worker starting");
log(`  url=${cfg.baseUrl}  worker_id=${cfg.workerId}`);
log(
  `  adapter=${adapter.name}  transport=${cfg.transport}  maxConcurrency=${cfg.maxConcurrency}  lock=${cfg.lockSeconds}s`
);
if (cfg.transport === "gateway") log(`  gateway=${cfg.gatewayUrl}`);
heartbeatLoop();
pollLoop();
gatewayLoop();
