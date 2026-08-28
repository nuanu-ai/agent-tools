import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export const RUNTIME_ADAPTERS = Object.freeze([
  Object.freeze({ key: "codex", binary: "codex", versionArgs: ["--version"], authArgs: ["login", "status"] }),
  Object.freeze({ key: "claude-code", binary: "claude", versionArgs: ["--version"], authArgs: ["auth", "status"] }),
]);

function safeText(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240);
}

function parsedVersion(value) {
  const match = String(value || "").match(/\bv?(\d+)\.(\d+)(?:\.(\d+))?\b/i);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3] || 0)}` : "";
}

function authReady(output) {
  const text = String(output || "").toLowerCase();
  if (/not (?:logged|signed) in|unauthenticated|authentication required|no credentials/.test(text)) return false;
  return /logged in|authenticated|signed in|ready/.test(text);
}

export function runAllowedCommand(binary, args, { spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnImpl(binary, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH || "" },
        windowsHide: true,
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    const append = (current, chunk) => (current + String(chunk)).slice(0, MAX_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ code, signal, stdout, stderr }));
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        finish({ timedOut: true, stdout, stderr });
      },
      Math.max(100, timeoutMs)
    );
    timer.unref?.();
  });
}

function failureStatus(error) {
  if (error?.code === "ENOENT") return "not_found";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission_failure";
  return "probe_failed";
}

export async function discoverRuntime(adapter, options = {}) {
  const versionResult = await runAllowedCommand(adapter.binary, adapter.versionArgs, options);
  if (versionResult.error)
    return { key: adapter.key, binary: adapter.binary, status: failureStatus(versionResult.error) };
  if (versionResult.timedOut)
    return { key: adapter.key, binary: adapter.binary, status: "probe_failed", detail: "timeout" };
  if (versionResult.code !== 0) {
    return { key: adapter.key, binary: adapter.binary, status: "probe_failed", detail: safeText(versionResult.stderr) };
  }
  const version = parsedVersion(`${versionResult.stdout} ${versionResult.stderr}`);
  if (!version) return { key: adapter.key, binary: adapter.binary, status: "unsupported_version" };

  const authResult = await runAllowedCommand(adapter.binary, adapter.authArgs, options);
  if (authResult.error) {
    return { key: adapter.key, binary: adapter.binary, version, status: failureStatus(authResult.error) };
  }
  const authOutput = `${authResult.stdout || ""} ${authResult.stderr || ""}`;
  return {
    key: adapter.key,
    binary: adapter.binary,
    version,
    status: !authResult.timedOut && authResult.code === 0 && authReady(authOutput) ? "ready" : "unauthenticated",
  };
}

export async function discoverRuntimes({ adapters = RUNTIME_ADAPTERS, ...options } = {}) {
  const runtimes = [];
  for (const adapter of adapters) runtimes.push(await discoverRuntime(adapter, options));
  return { schema_version: "nuanu.runtime-inventory.v1", runtimes };
}
