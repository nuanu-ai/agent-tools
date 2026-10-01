const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Phase-2 transport: dial the WS gateway and fetch on wake. Reconnects with a
// fixed backoff. Uses Node's built-in WebSocket (no dependency).
export async function runWorkerGateway({ cfg, client, isRunning, pumpOnce, agentBus, log }) {
  if (cfg.transport !== "gateway") return;
  while (isRunning()) {
    // Mint a fresh single-use ticket over HTTPS (durable key in a header) and put only
    // that ephemeral ticket in the WS URL — never the durable agent key.
    let ticket;
    try {
      ({ ticket } = await client.wsTicket());
    } catch (e) {
      log("ws-ticket failed:", e.message);
      if (isRunning()) await sleep(3000);
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
    if (isRunning()) await sleep(3000);
  }
}
