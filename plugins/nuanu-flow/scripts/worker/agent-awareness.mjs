/**
 * Background delivery adapter for informational agent-bus messages.
 *
 * The worker never forwards message bodies into the task pump. A wake only
 * schedules an authenticated inbox fetch and marks the returned IDs delivered.
 * Consumption remains a separate, explicitly delegated operation.
 */
export function createAgentInbox({ client, onError = () => {} }) {
  let workspacePromise;
  let scheduled = false;
  let pending = false;
  let inFlight;

  const workspace = () => {
    workspacePromise ||= client.whoami().then((identity) => identity.workspace);
    return workspacePromise;
  };

  const drain = async () => {
    const workspaceSlug = await workspace();
    const messages = await client.listAgentInbox(workspaceSlug);
    const messageIds = messages.map((message) => message.id).filter(Boolean);
    if (messageIds.length > 0) {
      await client.acknowledgeAgentMessages(workspaceSlug, messageIds, "delivered");
    }
  };

  const notify = () => {
    pending = true;
    if (scheduled || inFlight) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!pending || inFlight) return;
      pending = false;
      const operation = drain()
        .catch((error) => {
          onError(error);
        })
        .finally(() => {
          if (inFlight === operation) inFlight = undefined;
          if (pending) notify();
        });
      inFlight = operation;
    });
  };

  const whenIdle = async () => {
    while (scheduled || inFlight) {
      if (scheduled) await new Promise((resolve) => queueMicrotask(resolve));
      if (inFlight) await inFlight;
    }
  };

  return { notify, whenIdle };
}

export function routeGatewayMessage(message, { pumpTasks, notifyInbox }) {
  if (!message || typeof message !== "object") return;
  if (message.type === "connected" || message.type === "task") pumpTasks();
  if (message.type === "connected" || message.type === "inbox_available") notifyInbox();
}
