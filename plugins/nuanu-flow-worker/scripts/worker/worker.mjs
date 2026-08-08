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
import { buildCanonicalCompletion, makeAdapter, rewriteInternalMcpHostname } from "./adapter.mjs";
import { loadAgentBusAdapter } from "./agent_bus_loader.mjs";
import { createArtifactPublisher } from "./artifact_publisher.mjs";
import { createTaskLogStore } from "./diagnostic_log.mjs";
import {
  createEligibilityDiagnosticReporter,
  formatTaskDiagnostic,
  processActivityEvent,
  safeTaskEvent,
} from "./diagnostics.mjs";
import { createTaskObservability, diagnosticFromActivityEvent, diagnosticFromTaskEvent } from "./observability.mjs";
import { RepositoryManager } from "./repository.mjs";
import { cleanupBrowserQaRuntime, prepareBrowserQaRuntime } from "./qa_runtime.mjs";
import {
  cleanupSessionActivity,
  createSessionActivityStore,
  renderActivity,
  safeTaskTitle,
} from "./session_activity.mjs";
import { TaskWorkspaceManager } from "./task_workspace.mjs";
import { buildFailureCompletion, createCanonicalCompletionSender, deliverTerminal } from "./terminal_delivery.mjs";
import { ensureStructuredTextArtifacts } from "./structured_artifact_materializer.mjs";
import { resolveStructuredInputArtifacts } from "./input_artifact_context.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const cfg = loadConfig();
const client = new NuanuClient(cfg.baseUrl, cfg.agentKey, fetch, { requestTimeoutMs: cfg.requestTimeoutMs });
const adapter = makeAdapter(cfg.adapter);
const eligibilityDiagnostics = createEligibilityDiagnosticReporter({
  emit: (message) => log(message),
});
const repositories = new RepositoryManager({
  client,
  workerId: cfg.workerId,
  cacheDir: cfg.repository.cacheDir,
  worktreeDir: cfg.repository.worktreeDir,
});
const workspaces = new TaskWorkspaceManager(cfg.taskWorkspace);
const diagnosticLogs = createTaskLogStore({
  ...cfg.diagnostics,
  workerId: cfg.workerId,
});
const sessionActivity = createSessionActivityStore({
  activityDirectory: cfg.activity.directory,
  ownerSessionId: cfg.activity.ownerSessionId,
  workerId: cfg.workerId,
  agentId: cfg.activity.agentId,
  agentName: cfg.activity.agentName,
  onEvent(event) {
    const rendered = renderActivity(event);
    if (rendered) log(rendered);
  },
});
const agentBusLoad = await loadAgentBusAdapter({
  scriptPath: cfg.agentBusScript,
  client,
  onError: (error) => log("agent bus degraded:", error.message),
});
const agentBus = agentBusLoad.adapter;

let running = true;
let inFlight = 0;
const activeProcessRuns = new Map();
const activeTaskObservability = new Map();
let lastInboxPollAt = 0;

let heartbeatOk = false;

async function collectStaleTaskWorkspaces() {
  try {
    const removed = await workspaces.collectStale();
    if (cfg.debug && removed.length) log(`task_workspace_gc=completed removed=${removed.length}`);
  } catch (_error) {
    if (cfg.debug) log("task_workspace_gc=failed");
  }
}

function taskNeedsFilePublisher(task) {
  return (
    Boolean(task?.runtime_binding?.source_work_item_id) ||
    Object.values(task?.request?.output_definition?.artifacts || {}).some(
      (artifact) => !["git.commit", "git.branch", "git.pull_request", "external.link"].includes(String(artifact?.kind))
    )
  );
}

function taskMayWriteRepository(task) {
  return Object.values(task?.request?.output_definition?.artifacts || {}).some((artifact) =>
    ["git.commit", "git.branch"].includes(String(artifact?.kind))
  );
}

function terminalDeadline(task) {
  const now = Date.now();
  const candidates = [task?.runtime_binding?.task_deadline_at, task?.task_credential_expires_at]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value) && value > now + 1000);
  return new Date(Math.min(now + 60_000, ...(candidates.length ? candidates : [now + 30_000]))).toISOString();
}

function failureCode(error, fallback = "internal_error") {
  if (error?.code && /^[a-z][a-z0-9_]{1,63}$/.test(String(error.code))) return String(error.code);
  const message = String(error?.message || error || "");
  if (/invalid nuanu\.agent-task|artifacts must be an array/i.test(message)) return "invalid_output";
  if (error?.status === 400) return "invalid_input";
  if (error?.status === 401) return "authentication_required";
  if (error?.status === 403) return "permission_denied";
  if (error?.status === 408) return "timeout";
  return fallback;
}

function firstContractIssue(error) {
  const response = error?.response && typeof error.response === "object" ? error.response : {};
  const issue = Array.isArray(response.issues) ? response.issues[0] : null;
  if (issue) {
    return {
      code: String(issue.code || "invalid_output"),
      path: String(issue.path || "$"),
      message: String(issue.message || "The server rejected the result contract."),
    };
  }
  for (const [field, value] of Object.entries(response)) {
    const message = Array.isArray(value) ? value[0] : value;
    if (typeof message === "string" && message.trim()) {
      return { code: "invalid_output", path: `$.${field}`, message: message.trim() };
    }
  }
  return { code: "invalid_output", path: "$", message: "The server rejected the result contract." };
}

async function heartbeatLoop() {
  while (running) {
    try {
      const activeRunId = activeProcessRuns.values().next().value;
      await client.heartbeat(cfg.workerId, {
        status: inFlight > 0 ? "working" : "idle",
        activity_label: inFlight > 0 ? "Running delegated task" : "",
        related_object: activeRunId ? { type: "process", id: activeRunId } : null,
      });
      await Promise.allSettled([...activeTaskObservability.values()].map((observability) => observability.refresh()));
      void sessionActivity.heartbeat({ connection: "connected" });
      if (!heartbeatOk) {
        heartbeatOk = true;
        // Positive signal for launchers (e.g. /nuanu-flow:launch-remote-agent)
        // and for humans watching the log: the token is live and the platform
        // now shows this agent as online.
        log("remote agent connected — heartbeat OK");
      }
    } catch (e) {
      if (heartbeatOk) void sessionActivity.heartbeat({ connection: "disconnected" });
      heartbeatOk = false;
      log("heartbeat failed:", e.message);
    }
    await sleep(cfg.heartbeatIntervalMs);
  }
}

async function handleTask(task) {
  task = rewriteInternalMcpHostname(task, cfg.internalMcpHostname);
  const label = `${String(task.task_id).slice(0, 8)} ${task.step_id}`;
  const title = safeTaskTitle(task);
  activeProcessRuns.set(task.task_id, task.run_id);
  let renewing = false;
  let leaseLost = false;
  let terminalDeliveryStarted = false;
  let mayCleanupWorkspace = false;
  let taskRoot = null;
  let phaseSequence = 0;
  let activitySequence = 0;
  const recentActivity = new Map();
  const phaseWrites = [];
  const configuredModel = String(task.configuration_snapshot?.model || "");
  const taskObservability = createTaskObservability({
    task,
    workerId: cfg.workerId,
    adapter: adapter.name,
    client,
    leaseToken: task.lease_token,
    logStore: diagnosticLogs,
    onDiagnostic: (record) => sessionActivity.publish({ diagnostic: record, safeTitle: title, flowUrl: task.flow_url }),
    onWarning: (error) => {
      if (cfg.debug) log("task observability delivery failed", label, error.message);
    },
  });
  activeTaskObservability.set(task.task_id, taskObservability);
  const observe = (value) => {
    const write = taskObservability.record({
      ...(configuredModel
        ? {
            model: configuredModel,
            provider: configuredModel.includes("/") ? configuredModel.split("/", 1)[0] : undefined,
          }
        : {}),
      ...value,
    });
    phaseWrites.push(write);
    return write;
  };
  observe({ category: "worker", phase: "task_claimed", level: "info" });
  log("claimed", label);
  const recordPhase = (value, { persist = false } = {}) => {
    const event = safeTaskEvent(value);
    const diagnostic = event ? diagnosticFromTaskEvent(event) : diagnosticFromActivityEvent(value);
    if (event) {
      const message = formatTaskDiagnostic(event);
      if (cfg.debug && message) log(message);
    }
    if (diagnostic) observe(diagnostic);
    if (!event) return;
    if (!persist || leaseLost) return;
    const externalEventId = `worker:${task.lease_generation || task.attempt || 1}:${++phaseSequence}:${event.phase}`;
    phaseWrites.push(
      client
        .appendTaskEvent(task.task_id, {
          workerId: cfg.workerId,
          leaseToken: task.lease_token,
          event: { event_type: "activity", payload: event, external_event_id: externalEventId },
        })
        .catch((error) => {
          if (error.status === 409) leaseLost = true;
          if (cfg.debug && error.status !== 409) log("task diagnostic delivery failed", label, error.status || 0);
        })
    );
  };
  const recordLiveActivity = (value) => {
    const activity = processActivityEvent(value);
    if (!activity || leaseLost) return;
    const activityState = activity.data?.state || activity.kind;
    const activitySignature = `${activity.activity_id || "event"}:${activityState}:${activity.summary}`;
    const previousAt = recentActivity.get(activitySignature) || 0;
    const now = Date.now();
    if (now - previousAt < 1000) return;
    if (recentActivity.size >= 200) recentActivity.clear();
    recentActivity.set(activitySignature, now);
    const producerEventId = `worker:${task.lease_generation || task.attempt || 1}:${++activitySequence}`;
    phaseWrites.push(
      client
        .appendTaskEvent(task.task_id, {
          workerId: cfg.workerId,
          leaseToken: task.lease_token,
          event: {
            event_type: "activity",
            payload: { ...activity, producer_event_id: producerEventId },
            external_event_id: producerEventId,
          },
        })
        .catch((error) => {
          if (error.status === 409) leaseLost = true;
          if (cfg.debug && error.status !== 409) log("live activity delivery failed", label, error.status || 0);
        })
    );
  };
  const flushPhaseWrites = async () => {
    while (phaseWrites.length) await Promise.all(phaseWrites.splice(0));
  };
  const checkpoint = async (phase, details = {}) => {
    await client.checkpointTask(task.task_id, {
      workerId: cfg.workerId,
      leaseToken: task.lease_token,
      checkpoint: {
        phase,
        ...(taskObservability.currentProgress() ? { progress: taskObservability.currentProgress() } : {}),
        repository: task.repository
          ? {
              full_name: task.repository.full_name,
              branch_name: task.repository.branch_name,
            }
          : null,
        ...details,
      },
    });
  };
  const renewIntervalMs = Math.max(10000, Math.floor((cfg.lockSeconds * 1000) / 3));
  const renewLease = async ({ scheduled = false } = {}) => {
    if (renewing) return;
    renewing = true;
    try {
      await client.renewTask(task.task_id, {
        workerId: cfg.workerId,
        leaseToken: task.lease_token,
        lockSeconds: cfg.lockSeconds,
      });
    } catch (error) {
      // A scheduled renewal may already be in flight when terminal delivery
      // releases the lease. That 409 is an expected race, not another worker.
      if (scheduled && terminalDeliveryStarted && error.status === 409) return;
      log("task lease renewal failed", label, "-", error.message);
      if (error.status === 409) leaseLost = true;
      throw error;
    } finally {
      renewing = false;
    }
  };
  const leaseTimer = setInterval(
    () => void (!terminalDeliveryStarted && renewLease({ scheduled: true }).catch(() => {})),
    renewIntervalMs
  );
  leaseTimer.unref?.();
  const deliver = async (send) => {
    terminalDeliveryStarted = true;
    clearInterval(leaseTimer);
    observe({ category: "delivery", phase: "terminal_delivery_started", level: "info" });
    await flushPhaseWrites();
    const delivery = await deliverTerminal({
      send,
      renew: renewLease,
      deadlineAt: terminalDeadline(task),
      onRetry: ({ attempt, status }) => recordPhase({ phase: "terminal_delivery_retrying", attempt, status }),
    });
    mayCleanupWorkspace = ["acknowledged", "fenced"].includes(delivery.state);
    recordPhase(
      {
        phase: `terminal_delivery_${delivery.state}`,
        attempt: delivery.attempts,
        status: delivery.status,
      },
      { persist: false }
    );
    return delivery;
  };
  const canonicalFailureSend = (code, message, retryable = false) =>
    createCanonicalCompletionSender({
      client,
      task,
      workerId: cfg.workerId,
      leaseToken: task.lease_token,
      completion: buildFailureCompletion(task, {
        code,
        message,
        retryable,
      }),
    });
  try {
    taskRoot = await workspaces.prepare(task);
    task._task_root = taskRoot;
    recordPhase({ phase: "task_workspace_ready" });
    if (task.runtime_setup_error) {
      const message = task.runtime_setup_error.message || "A required runtime capability is unavailable";
      const send =
        task.contract_version === "nuanu.agent-task.v1"
          ? canonicalFailureSend("capability_unavailable", message)
          : () => client.completeError(task.task_id, message, cfg.workerId, task.lease_token);
      const delivery = await deliver(send);
      if (delivery.state === "acknowledged") {
        observe({ category: "worker", phase: "task_failed", level: "error", safe_message: message });
      }
      log("runtime setup unavailable", label, "-", task.runtime_setup_error.code || "capability_unavailable");
      if (delivery.state === "unacknowledged") log("terminal delivery unacknowledged", label);
      return;
    }
    await checkpoint("task_initialized", { resume_count: task.resume_count || 0 });
    if (task.repository) {
      observe({ category: "repository", phase: "repository_preparing", level: "info" });
      await repositories.prepare(task);
      observe({ category: "repository", phase: "repository_ready", level: "info" });
      const repositoryState = repositories.tasks.get(task.task_id);
      log(
        "repository prepared",
        label,
        task.repository.full_name,
        task.repository.branch_name,
        repositoryState?.cacheReused ? "cache=reused" : "cache=cloned"
      );
      await checkpoint("repository_prepared");
    }
    const qaRuntime = await prepareBrowserQaRuntime(task, {
      playwrightModule: cfg.browserQaPlaywrightModule || undefined,
    });
    if (qaRuntime) {
      log("browser QA runtime prepared", label, `port=${qaRuntime.port}`);
      await checkpoint("browser_qa_prepared", { port: qaRuntime.port });
    }
    const taskClient = new NuanuClient(cfg.baseUrl, task.agent_key, fetch, {
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    task._resolved_input_artifacts = await resolveStructuredInputArtifacts({ task, client: taskClient });
    const publisher = taskNeedsFilePublisher(task)
      ? createArtifactPublisher({
          task,
          taskRoot,
          client: taskClient,
          maxBytes: cfg.artifactMaxBytes,
          workspaces,
          onPhase: recordPhase,
        })
      : null;
    observe({ category: "runtime", phase: "runtime_starting", level: "info" });
    observe({ category: "runtime", phase: "runtime_working", level: "info" });
    recordLiveActivity({ kind: "task.started", safe_summary: "Agent execution started" });
    const result = await adapter.handle(task, { taskRoot, publisher, onActivity: recordLiveActivity });
    if (leaseLost) throw new Error("Task lease was lost while the agent was running");
    for (const [index, event] of (result.events || []).entries()) {
      await client.appendTaskEvent(task.task_id, {
        workerId: cfg.workerId,
        leaseToken: task.lease_token,
        event: {
          ...event,
          external_event_id:
            event.external_event_id || `adapter:${task.lease_generation || task.attempt || 1}:${index}`,
        },
      });
    }
    if (result.status === "ok") {
      // Validate the authored ProcessItem before any repository-side effect.
      buildCanonicalCompletion(task, result, null);
      await ensureStructuredTextArtifacts({ task, result, publisher, client: taskClient, taskRoot });
      let repositoryResult = null;
      if (task.repository && taskMayWriteRepository(task)) {
        repositoryResult = await repositories.finalize(task);
      } else if (task.repository) {
        repositoryResult = await repositories.verifyReadOnly(task);
      }
      const completion = buildCanonicalCompletion(task, result, repositoryResult);
      let contractRejected = false;
      await checkpoint("before_completion", {
        adapter_session_id: result.meta?.session_id || result.meta?.thread_id || "",
        repository_result: repositoryResult,
        completion,
      });
      const send = completion
        ? createCanonicalCompletionSender({
            client,
            task,
            workerId: cfg.workerId,
            leaseToken: task.lease_token,
            completion,
            output: result.output,
            options: result.options,
            repositoryResult,
            onContractRejected: (error) => {
              contractRejected = true;
              const issue = firstContractIssue(error);
              const issueCode = issue.code;
              const issuePath = issue.path;
              const issueMessage = issue.message;
              if (cfg.debug) log(`completion_contract=rejected code=${issueCode} path=${issuePath}`);
              observe({
                category: "delivery",
                phase: "provider_error",
                level: "error",
                error_code: "invalid_output",
                safe_message: `${issuePath}: ${issueMessage}`,
              });
              return issue;
            },
          })
        : () =>
            client.complete(task.task_id, {
              output: result.output,
              options: result.options,
              workerId: cfg.workerId,
              leaseToken: task.lease_token,
              repositoryResult,
            });
      const delivery = await deliver(send);
      if (delivery.state === "acknowledged" && !contractRejected) {
        observe({
          category: "worker",
          phase: "task_completed",
          level: "info",
          session_id: result.meta?.session_id || result.meta?.thread_id,
          turn_id: result.meta?.turn_id,
        });
      } else if (delivery.state === "acknowledged" && contractRejected) {
        observe({
          category: "delivery",
          phase: "task_failed",
          level: "error",
          error_code: "invalid_output",
          safe_message: "The server rejected the Agent Task result contract.",
        });
      }
      const runId = result.meta?.session_id || result.meta?.thread_id;
      log(
        delivery.state === "acknowledged" && !contractRejected
          ? "completed"
          : contractRejected
            ? "completion-rejected"
            : `completion-${delivery.state}`,
        label,
        runId ? `(session ${String(runId).slice(0, 8)})` : ""
      );
    } else if (result.status === "waiting_input") {
      observe({
        category: "human_input",
        phase: "waiting_for_human",
        level: "info",
        session_id: result.meta?.session_id || result.meta?.thread_id,
        turn_id: result.meta?.turn_id,
      });
      await checkpoint("waiting_for_human", {
        adapter_thread_id: result.meta?.thread_id || "",
        adapter_turn_id: result.meta?.turn_id || "",
      });
      const response = await client.requestHuman(task.task_id, {
        request: result.request,
        workerId: cfg.workerId,
        leaseToken: task.lease_token,
      });
      if (!["waiting_input", "advisory"].includes(response?.status)) {
        throw Object.assign(new Error("Human-input request was not acknowledged"), { code: "protocol_error" });
      }
      log("waiting-for-human", label);
    } else {
      const message = String(result.error || "Remote agent failed").slice(0, 4000);
      observe({
        category: "provider",
        phase: "provider_error",
        level: "error",
        session_id: result.meta?.session_id || result.meta?.thread_id,
        turn_id: result.meta?.turn_id,
        error_code: failureCode(result, "provider_error"),
        retryable: Boolean(result.retryable),
        safe_message: message,
      });
      const send =
        task.contract_version === "nuanu.agent-task.v1"
          ? canonicalFailureSend(failureCode(result, "provider_error"), message)
          : () => client.completeError(task.task_id, message, cfg.workerId, task.lease_token);
      const delivery = await deliver(send);
      if (delivery.state === "acknowledged") {
        observe({
          category: "provider",
          phase: "task_failed",
          level: "error",
          session_id: result.meta?.session_id || result.meta?.thread_id,
          turn_id: result.meta?.turn_id,
          error_code: failureCode(result, "provider_error"),
          retryable: Boolean(result.retryable),
          safe_message: message,
        });
      }
      log(`completed-with-error-${delivery.state}`, label, "-", message.slice(0, 140));
    }
  } catch (e) {
    if (leaseLost || e.code === "lease_lost") {
      log("aborting stale task", label, "-", e.message);
      return;
    }
    log("worker error on", label, "-", e.message, "-> terminal failure");
    try {
      const message = String(e.message || "Remote worker failed").slice(0, 4000);
      const send =
        task.contract_version === "nuanu.agent-task.v1"
          ? canonicalFailureSend(failureCode(e), message, Boolean(e.retryable))
          : () => client.completeError(task.task_id, message, cfg.workerId, task.lease_token);
      const delivery = await deliver(send);
      if (delivery.state === "acknowledged") {
        observe({
          category: failureCode(e) === "provider_error" ? "provider" : "worker",
          phase: "task_failed",
          level: "error",
          error_code: failureCode(e),
          retryable: Boolean(e.retryable),
          safe_message: message,
        });
      }
      if (delivery.state === "unacknowledged") {
        log("terminal failure remained unacknowledged", label, "- server lease sweeper will recover it");
      }
    } catch (e2) {
      log("terminal failure delivery also errored:", e2.message);
    }
  } finally {
    clearInterval(leaseTimer);
    await flushPhaseWrites();
    try {
      await cleanupBrowserQaRuntime(task);
    } catch (cleanupError) {
      log("browser QA cleanup failed:", cleanupError.message);
    }
    try {
      await repositories.cleanup(task);
    } catch (cleanupError) {
      log("repository cleanup failed:", cleanupError.message);
    }
    if (mayCleanupWorkspace && taskRoot) {
      try {
        await workspaces.cleanup(task);
      } catch (cleanupError) {
        log("task workspace cleanup failed:", cleanupError.message);
      }
    }
    activeProcessRuns.delete(task.task_id);
    activeTaskObservability.delete(task.task_id);
    await sessionActivity.flush();
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
          capabilities: cfg.capabilities,
          debug: cfg.debug,
        });
        if (cfg.debug) eligibilityDiagnostics.observe(res.diagnostics);
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
    if (Date.now() - lastInboxPollAt >= 15000) {
      lastInboxPollAt = Date.now();
      agentBus.notify();
    }
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
        void pumpOnce();
        agentBus.routeGatewayMessage({ type: "connected" });
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg?.type === "task") void pumpOnce();
        agentBus.routeGatewayMessage(msg);
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
  void sessionActivity.heartbeat({ connection: "stopped" });
  running = false;
  const started = Date.now();
  const timer = setInterval(() => {
    if (inFlight === 0 || Date.now() - started > 30000) {
      clearInterval(timer);
      void sessionActivity.flush().finally(() => process.exit(0));
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
log(`  capabilities=${[...cfg.capabilities].sort().join(",")}  debug=${cfg.debug ? "on" : "off"}`);
log(`  session_activity=${sessionActivity.enabled ? "attached" : "unavailable (no Codex session id)"}`);
log(`  agent_bus=${agentBusLoad.status}${agentBusLoad.reason ? ` reason=${agentBusLoad.reason}` : ""}`);
if (cfg.transport === "gateway") log(`  gateway=${cfg.gatewayUrl}`);
void collectStaleTaskWorkspaces();
void diagnosticLogs.cleanup().catch(() => {});
void cleanupSessionActivity({ activityDirectory: cfg.activity.directory }).catch(() => {});
const workspaceGcTimer = setInterval(() => void collectStaleTaskWorkspaces(), 60 * 60 * 1000);
workspaceGcTimer.unref?.();
const sessionActivityGcTimer = setInterval(
  () => void cleanupSessionActivity({ activityDirectory: cfg.activity.directory }).catch(() => {}),
  24 * 60 * 60 * 1000
);
sessionActivityGcTimer.unref?.();
heartbeatLoop();
pollLoop();
gatewayLoop();
if (process.env.NUANU_CHAT_DISABLED !== "1") {
  import("./interactive_chat.mjs")
    .then(({ startChatLoop }) => startChatLoop({ client, cfg, isRunning: () => running, log }))
    .catch((error) => log("chat loop unavailable: " + error.message));
}
