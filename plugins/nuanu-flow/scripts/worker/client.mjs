/**
 * Thin HTTP client for the Nuanu remote-agent task-lifecycle endpoints.
 * Auth is the durable agent key (X-Agent-Key), which also scopes the worker to
 * only its own agent's tasks. See docs/REMOTE_AGENTS.md.
 */
export class NuanuClient {
  constructor(baseUrl, agentKey) {
    this.baseUrl = baseUrl;
    this.agentKey = agentKey;
  }

  async _post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Key": this.agentKey,
      },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  heartbeat(workerId) {
    return this._post("/agent-worker/heartbeat/", { worker_id: workerId });
  }

  // Mint a short-lived, single-use ticket for the gateway WebSocket so the durable
  // agent key never appears in the (proxy-logged) WS URL. Returns { ticket, expires_in }.
  wsTicket() {
    return this._post("/agent-worker/ws-ticket/", {});
  }

  fetchAndLock({ workerId, maxTasks, lockSeconds }) {
    return this._post("/agent-worker/tasks/fetch-and-lock/", {
      worker_id: workerId,
      max_tasks: maxTasks,
      lock_seconds: lockSeconds,
    });
  }

  complete(taskId, { output, options, workerId }) {
    return this._post(`/agent-worker/tasks/${taskId}/complete/`, {
      status: "ok",
      worker_id: workerId,
      output,
      ...(options ? { options } : {}),
    });
  }

  completeError(taskId, error, workerId) {
    return this._post(`/agent-worker/tasks/${taskId}/complete/`, {
      status: "error",
      worker_id: workerId,
      error: String(error).slice(0, 2000),
    });
  }

  fail(taskId, { error, requeue = true, workerId }) {
    return this._post(`/agent-worker/tasks/${taskId}/fail/`, {
      worker_id: workerId,
      error: String(error).slice(0, 2000),
      requeue,
    });
  }
}
