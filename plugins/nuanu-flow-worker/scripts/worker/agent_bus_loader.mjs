import path from "node:path";
import { pathToFileURL } from "node:url";

function degradedAdapter() {
  return {
    notify() {},
    routeGatewayMessage() {
      return false;
    },
    async whenIdle() {},
  };
}

/**
 * Load the communication-bus implementation from the separately installed
 * general plugin. The exact path is supplied by the paired-install launcher;
 * the worker never guesses a sibling cache directory. Failure is intentionally
 * non-blocking because worker heartbeat/task execution remain authoritative.
 */
export async function loadAgentBusAdapter({ scriptPath, client, onError = () => {} }) {
  if (!scriptPath) {
    return {
      adapter: degradedAdapter(),
      status: "degraded",
      reason: "not_configured",
    };
  }

  try {
    const absolutePath = path.resolve(scriptPath);
    const module = await import(pathToFileURL(absolutePath).href);
    if (typeof module.createAgentBusAdapter !== "function") {
      throw new Error("general plugin bus script does not export createAgentBusAdapter");
    }
    const adapter = module.createAgentBusAdapter({ client, onError });
    if (!adapter || typeof adapter.notify !== "function" || typeof adapter.routeGatewayMessage !== "function") {
      throw new Error("general plugin bus script returned an invalid adapter");
    }
    return { adapter, status: "ready", reason: "" };
  } catch (error) {
    onError(error);
    return {
      adapter: degradedAdapter(),
      status: "degraded",
      reason: "load_failed",
    };
  }
}
