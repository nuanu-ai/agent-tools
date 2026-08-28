/**
 * Thin HTTP client for the Nuanu remote-agent task-lifecycle endpoints.
 * Auth is the durable agent key (X-Agent-Key), which also scopes the worker to
 * only its own agent's tasks. See docs/REMOTE_AGENTS.md.
 */
export class NuanuClient {
  constructor(baseUrl, agentKey, fetchImpl = fetch, { requestTimeoutMs = 30_000 } = {}) {
    this.baseUrl = baseUrl;
    this.agentKey = agentKey;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || 30_000);
  }

  async _request(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "X-Agent-Key": this.agentKey,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      const err = new Error(timedOut ? `Request timed out for ${path}` : `Network request failed for ${path}`);
      err.status = timedOut ? 408 : 0;
      err.retryable = true;
      err.cause = cause;
      throw err;
    }
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
      err.retryable = res.status === 408 || res.status === 429 || (res.status >= 500 && res.status <= 599);
      err.response = data;
      throw err;
    }
    return data;
  }

  _post(path, body) {
    return this._request(path, { method: "POST", body: body || {} });
  }

  whoami() {
    return this._request("/agent-worker/whoami/");
  }

  chatSync({ cursors, waitSeconds = 0 } = {}) {
    return this._post("/agent-worker/chat/sync/", { cursors: cursors || {}, wait_seconds: waitSeconds });
  }

  chatPostEvents(sessionId, events) {
    return this._post(`/agent-worker/chat/${sessionId}/events/`, { events });
  }

  heartbeat(workerId, status = {}) {
    return this._post("/agent-worker/heartbeat/", { worker_id: workerId, ...status });
  }

  // Mint a short-lived, single-use ticket for the gateway WebSocket so the durable
  // agent key never appears in the (proxy-logged) WS URL. Returns { ticket, expires_in }.
  wsTicket() {
    return this._post("/agent-worker/ws-ticket/", {});
  }

  listAgentInbox(workspaceSlug, { importance, limit } = {}) {
    const query = new URLSearchParams();
    if (importance) query.set("importance", importance);
    if (limit !== undefined) query.set("limit", String(limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    return this._request(`/workspaces/${workspaceSlug}/agent-bus/inbox/${suffix}`).then(
      (response) => response.results || []
    );
  }

  acknowledgeAgentMessages(workspaceSlug, messageIds, state) {
    return this._post(`/workspaces/${workspaceSlug}/agent-bus/inbox/ack/`, {
      message_ids: messageIds,
      state,
    });
  }

  fetchAndLock({ workerId, maxTasks, lockSeconds, capabilities, debug = false }) {
    return this._post("/agent-worker/tasks/fetch-and-lock/", {
      worker_id: workerId,
      max_tasks: maxTasks,
      lock_seconds: lockSeconds,
      capabilities,
      ...(debug ? { debug: true } : {}),
    });
  }

  repositoryCredential(taskId, { workerId, leaseToken }) {
    return this._post(`/agent-worker/tasks/${taskId}/repository-credential/`, {
      worker_id: workerId,
      lease_token: leaseToken,
    });
  }

  renewTask(taskId, { workerId, leaseToken, lockSeconds }) {
    return this._post(`/agent-worker/tasks/${taskId}/renew/`, {
      worker_id: workerId,
      lease_token: leaseToken,
      lock_seconds: lockSeconds,
    });
  }

  checkpointTask(taskId, { workerId, leaseToken, checkpoint }) {
    return this._post(`/agent-worker/tasks/${taskId}/checkpoint/`, {
      worker_id: workerId,
      lease_token: leaseToken,
      checkpoint,
    });
  }

  appendTaskEvent(taskId, { workerId, leaseToken, event }) {
    return this._post(`/agent-worker/tasks/${taskId}/events/`, {
      worker_id: workerId,
      lease_token: leaseToken,
      event,
    });
  }

  complete(taskId, { completion, workerId, leaseToken, repositoryResult }) {
    return this._post(`/agent-worker/tasks/${taskId}/complete/`, {
      worker_id: workerId,
      lease_token: leaseToken,
      completion,
      ...(repositoryResult ? { repository_result: repositoryResult } : {}),
    });
  }

  requestHuman(taskId, { request, workerId, leaseToken }) {
    return this._post(`/agent-worker/tasks/${taskId}/human-input/`, {
      worker_id: workerId,
      lease_token: leaseToken,
      request,
      idempotency_key: request?.idempotency_key,
    });
  }

  completeError(taskId, error, workerId, leaseToken) {
    return this._post(`/agent-worker/tasks/${taskId}/complete/`, {
      status: "error",
      worker_id: workerId,
      lease_token: leaseToken,
      error: String(error).slice(0, 2000),
    });
  }

  fail(taskId, { error, requeue = true, workerId, leaseToken }) {
    return this._post(`/agent-worker/tasks/${taskId}/fail/`, {
      worker_id: workerId,
      lease_token: leaseToken,
      error: String(error).slice(0, 2000),
      requeue,
    });
  }

  getArtifact(workspaceSlug, artifactId) {
    return this._request(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${encodeURIComponent(artifactId)}/`
    );
  }

  createArtifact(workspaceSlug, input) {
    return this._post(`/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/`, input);
  }

  createArtifactVersion(workspaceSlug, artifactId, input) {
    return this._post(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${encodeURIComponent(artifactId)}/versions/`,
      input
    );
  }

  completeArtifactVersion(workspaceSlug, artifactId, versionId, input = {}) {
    return this._request(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/`,
      { method: "PATCH", body: input }
    );
  }

  commitArtifact(workspaceSlug, artifactId, input = {}) {
    return this._post(
      `/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${encodeURIComponent(artifactId)}/commit/`,
      input
    );
  }

  async uploadArtifactBytes(uploadData, bytes, filename, mediaType) {
    if (!uploadData?.url || !uploadData?.fields || typeof uploadData.fields !== "object") {
      throw new Error("Artifact upload contract is incomplete");
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(uploadData.fields)) form.append(key, String(value));
    form.append("file", new Blob([bytes], { type: mediaType }), filename);
    let res;
    try {
      res = await this.fetch(uploadData.url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      const error = new Error(timedOut ? "Artifact upload timed out" : "Artifact upload network failure");
      error.status = timedOut ? 408 : 0;
      error.retryable = true;
      error.cause = cause;
      throw error;
    }
    if (!res.ok) {
      const error = new Error(`Artifact upload failed with HTTP ${res.status}`);
      error.status = res.status;
      error.retryable = res.status === 408 || res.status === 429 || (res.status >= 500 && res.status <= 599);
      throw error;
    }
  }
}
