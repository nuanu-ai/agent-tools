/**
 * General Nuanu Flow communication-bus adapter.
 *
 * The adapter owns transient informational-message delivery for any host that
 * supplies an authenticated client. It does not claim work, start a model
 * turn, advance a Process, or keep a second roster/message store. A gateway
 * wake schedules an HTTP inbox fetch and marks transport delivery only;
 * explicit MCP inbox consumption remains a separate model-visible action.
 */
export function createAgentBusAdapter({ client, onError = () => {} }) {
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

  const routeGatewayMessage = (message) => {
    if (!message || typeof message !== "object") return false;
    if (message.type !== "connected" && message.type !== "inbox_available") return false;
    notify();
    return true;
  };

  const whenIdle = async () => {
    while (scheduled || inFlight) {
      if (scheduled) await new Promise((resolve) => queueMicrotask(resolve));
      if (inFlight) await inFlight;
    }
  };

  return { notify, routeGatewayMessage, whenIdle };
}
