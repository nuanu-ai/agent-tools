import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);

export function resolveBrowserQaPlaywrightModule({ env = process.env, resolve = require.resolve } = {}) {
  const configuredModule = String(env.NUANU_QA_PLAYWRIGHT_MODULE || "").trim();
  try {
    return resolve(configuredModule || "playwright");
  } catch (cause) {
    const error = new Error(
      "Browser QA is enabled but Playwright is unavailable. Install playwright on the worker host or set NUANU_QA_PLAYWRIGHT_MODULE to its exact module path."
    );
    error.code = "browser_qa_runtime_unavailable";
    error.cause = cause;
    throw error;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForCdp(cdpUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worker-provisioned browser did not expose CDP: ${lastError?.message || "timed out"}`);
}

async function launchBrowser({ playwrightModule, browserChannel, browserProfileDir, cdpPort }) {
  const { chromium } = require(playwrightModule);
  const context = await chromium.launchPersistentContext(browserProfileDir, {
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
    args: [`--remote-debugging-port=${cdpPort}`],
  });
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  try {
    await waitForCdp(cdpUrl);
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  return { cdpUrl, close: () => context.close() };
}

export async function prepareBrowserQaRuntime(
  task,
  { launch = launchBrowser, playwrightModule: configuredPlaywrightModule } = {}
) {
  if (!(task.required_worker_capabilities || []).includes("browser_qa_v1")) return null;
  if (!task._task_root) throw new Error("Browser QA requires an isolated task workspace");
  const playwrightModule = configuredPlaywrightModule || resolveBrowserQaPlaywrightModule();
  const root = path.join(task._task_root, "qa-runtime");
  await fs.rm(root, { recursive: true, force: true });
  const dataDir = path.join(root, "data");
  const browserProfileDir = path.join(root, "browser-profile");
  const evidenceDir = path.join(root, "evidence");
  const browserChannel = String(
    process.env.NUANU_QA_BROWSER_CHANNEL || (process.platform === "darwin" ? "chrome" : "")
  ).trim();
  await Promise.all(
    [dataDir, browserProfileDir, evidenceDir].map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 }))
  );
  const port = await freePort();
  const cdpPort = await freePort();
  const browserHandle = await launch({ playwrightModule, browserChannel, browserProfileDir, cdpPort });
  const runtime = {
    root,
    port,
    dataDir,
    browserProfileDir,
    evidenceDir,
    browserChannel,
    playwrightModule,
    browserHandle,
    cdpUrl: browserHandle.cdpUrl,
  };
  task._qa_runtime = runtime;
  task._runtime_env = {
    NUANU_QA_PORT: String(port),
    NUANU_QA_DATA_DIR: dataDir,
    NUANU_QA_BROWSER_PROFILE_DIR: browserProfileDir,
    NUANU_QA_EVIDENCE_DIR: evidenceDir,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    NUANU_QA_PLAYWRIGHT_MODULE: playwrightModule,
    NUANU_QA_BROWSER_CDP_URL: browserHandle.cdpUrl,
    ...(browserChannel ? { NUANU_QA_BROWSER_CHANNEL: browserChannel } : {}),
  };
  return runtime;
}

export async function cleanupBrowserQaRuntime(task) {
  const runtime = task._qa_runtime;
  delete task._qa_runtime;
  delete task._runtime_env;
  if (runtime?.browserHandle) await runtime.browserHandle.close().catch(() => undefined);
  if (runtime?.root) await fs.rm(runtime.root, { recursive: true, force: true });
}
