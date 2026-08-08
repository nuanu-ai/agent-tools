#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readMcpAuthStatus,
  runCodexWithBrowserAuth,
  runMcpLogin,
} from "./auth.mjs";
import { buildDevPackage } from "./dev-package.mjs";
import { readHookTrustStatus } from "./hook-status.mjs";
import {
  DEFAULT_BUILD_ROOT,
  REPO_ROOT,
  assertCodexVersion,
  canonicalFilesystemPath,
  codexHome as resolveCodexHome,
  modeConfig,
  runCodex,
} from "./modes.mjs";
import {
  attachmentAction,
  createPluginLifecycle,
} from "../plugin-lifecycle.mjs";

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function normalized(value) {
  return canonicalFilesystemPath(value);
}

function hasHeaderCredential(mode, env) {
  return Boolean(env[mode.tokenEnv] || env[mode.agentKeyEnv]);
}

function isCanonicalProductionMarketplace(entry) {
  const source = entry?.marketplaceSource?.source || "";
  return (
    entry?.marketplaceSource?.sourceType === "git" &&
    entry?.marketplaceSource?.ref === "main" &&
    (source === "nuanu-ai/agent-tools" ||
      /^https:\/\/github\.com\/nuanu-ai\/agent-tools(?:\.git)?$/.test(source) ||
      /^git@github\.com:nuanu-ai\/agent-tools(?:\.git)?$/.test(source))
  );
}

function isOwnedDevelopmentMarketplace(entry, buildRoot) {
  if (!entry) return false;
  const source = entry.marketplaceSource?.source || entry.root || "";
  return (
    entry.marketplaceSource?.sourceType === "local" &&
    normalized(source) === normalized(buildRoot)
  );
}

function resumeCommand(env = process.env) {
  const threadId = String(env.CODEX_THREAD_ID || "");
  const prompt = '"Continue Nuanu Flow setup"';
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(threadId)
    ? `codex resume ${threadId} ${prompt}`
    : `codex resume --last ${prompt}`;
}

export async function installCurrentProfile(modeName, options = {}) {
  const mode = modeConfig(modeName, options.env || process.env);
  const remoteAgent = Boolean(options.remoteAgent);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const buildRoot = path.resolve(options.buildRoot || DEFAULT_BUILD_ROOT);
  const explicitlySelectedHome =
    options.codexHome || options.env?.CODEX_HOME || process.env.CODEX_HOME;
  const home = path.resolve(
    explicitlySelectedHome ||
      resolveCodexHome({
        env: options.env,
      }),
  );
  const env = {
    ...process.env,
    ...options.env,
    CODEX_HOME: home,
  };
  const codexOptions = {
    codexBin: options.codexBin || "codex",
    cwd: repoRoot,
    env,
  };
  const version = runCodex(["--version"], codexOptions);
  assertCodexVersion(version.stdout);

  let build = null;
  if (modeName === "dev") {
    build = await buildDevPackage({
      pluginRoot:
        options.pluginRoot || path.join(repoRoot, "plugins/nuanu-flow"),
      workerPluginRoot:
        options.workerPluginRoot ||
        path.join(repoRoot, "plugins/nuanu-flow-worker"),
      buildRoot,
      env,
      force: options.force,
      now: options.now,
    });
  }

  const marketplaceBody = parseJson(
    runCodex(
      ["plugin", "marketplace", "list", "--json"],
      codexOptions,
    ).stdout,
    "Codex marketplace list",
  );
  const pluginBody = parseJson(
    runCodex(["plugin", "list", "--available", "--json"], codexOptions)
      .stdout,
    "Codex plugin list",
  );
  const marketplaces = marketplaceBody.marketplaces || [];
  const installed = pluginBody.installed || [];
  const actions = [];
  const otherMode = modeName === "dev" ? modeConfig("prod", env) : modeConfig("dev", env);
  const conflictingPlugins = installed.filter((plugin) =>
    [otherMode.pluginId, otherMode.workerPluginId].includes(plugin.pluginId),
  );

  if (conflictingPlugins.length > 0) {
    const authStatus = await readMcpAuthStatus(otherMode.name, {
      ...options,
      home,
      env,
    });
    if (authStatus === "o_auth") {
      runCodex(["mcp", "logout", mode.mcpName], codexOptions);
      actions.push(`logged out ${otherMode.label.toLowerCase()} OAuth`);
    }
    for (const conflictingPlugin of conflictingPlugins) {
      runCodex(
        ["plugin", "remove", conflictingPlugin.pluginId, "--json"],
        codexOptions,
      );
      actions.push(`removed conflicting ${conflictingPlugin.pluginId}`);
    }
  }

  const marketplace = marketplaces.find(
    (entry) => entry.name === mode.marketplace,
  );
  const desiredPluginIds = remoteAgent
    ? [mode.pluginId, mode.workerPluginId]
    : [mode.pluginId];
  const selectedPlugins = desiredPluginIds
    .map((pluginId) => installed.find((plugin) => plugin.pluginId === pluginId))
    .filter(Boolean);
  let installPluginIds = desiredPluginIds.filter(
    (pluginId) => !selectedPlugins.some((plugin) => plugin.pluginId === pluginId),
  );

  if (modeName === "dev") {
    if (marketplace && !isOwnedDevelopmentMarketplace(marketplace, buildRoot)) {
      throw new Error(
        "Refusing to replace a foreign marketplace named nuanu-dev.",
      );
    }
    const hasOutdatedPlugin = selectedPlugins.some(
      (plugin) => plugin.version !== build.version,
    );
    if (marketplace && hasOutdatedPlugin) {
      for (const selectedPlugin of selectedPlugins) {
        if (selectedPlugin.version === build.version) continue;
        runCodex(
          ["plugin", "remove", selectedPlugin.pluginId, "--json"],
          codexOptions,
        );
        actions.push(`removed outdated ${selectedPlugin.pluginId}`);
      }
      runCodex(
        ["plugin", "marketplace", "remove", mode.marketplace, "--json"],
        codexOptions,
      );
      actions.push(`refreshed ${mode.marketplace} marketplace`);
      installPluginIds = [...desiredPluginIds];
    }
    if (!marketplace || hasOutdatedPlugin) {
      runCodex(
        [
          "plugin",
          "marketplace",
          "add",
          build.marketplaceRoot,
          "--json",
        ],
        codexOptions,
      );
      actions.push(`registered ${mode.marketplace} marketplace`);
    }
  } else {
    if (marketplace && !isCanonicalProductionMarketplace(marketplace)) {
      throw new Error(
        "Refusing to replace a noncanonical marketplace named nuanu.",
      );
    }
    if (!marketplace) {
      runCodex(
        [
          "plugin",
          "marketplace",
          "add",
          "nuanu-ai/agent-tools",
          "--ref",
          "main",
          "--json",
        ],
        codexOptions,
      );
      actions.push("registered canonical nuanu marketplace");
    } else {
      runCodex(
        ["plugin", "marketplace", "upgrade", mode.marketplace, "--json"],
        codexOptions,
      );
      actions.push("refreshed canonical nuanu marketplace");
    }
    installPluginIds = [...desiredPluginIds];
  }

  for (const pluginId of installPluginIds) {
    if (remoteAgent) {
      runCodex(["plugin", "add", pluginId, "--json"], codexOptions);
    } else {
      await runCodexWithBrowserAuth(["plugin", "add", pluginId, "--json"], {
        ...options,
        cwd: repoRoot,
        env,
        home,
      });
    }
    actions.push(`installed ${pluginId}`);
  }

  const headerCredentialPresent = hasHeaderCredential(mode, env);
  let authStatus = remoteAgent
    ? "skipped"
    : headerCredentialPresent
    ? "environment_credential"
    : await readMcpAuthStatus(modeName, {
        ...options,
        home,
        env,
      });
  if (!remoteAgent && authStatus === "not_logged_in") {
    await runMcpLogin(modeName, {
      ...options,
      home,
      env,
    });
    authStatus = await readMcpAuthStatus(modeName, {
      ...options,
      home,
      env,
    });
  }
  const authenticationReady =
    remoteAgent ||
    authStatus === "o_auth" ||
    authStatus === "environment_credential";
  if (!authenticationReady) {
    throw new Error(
      `Nuanu Flow authentication did not become ready (status: ${authStatus}). ` +
        "Complete OAuth, or provide the documented token or agent-key environment variable.",
    );
  }

  const verifiedPlugins = parseJson(
    runCodex(["plugin", "list", "--available", "--json"], codexOptions)
      .stdout,
    "Codex plugin verification",
  );
  const verifiedMcp = remoteAgent
    ? null
    : parseJson(
        runCodex(
          headerCredentialPresent
            ? ["mcp", "get", mode.mcpName, "--json"]
            : ["mcp", "list", "--json"],
          codexOptions,
        ).stdout,
        "Codex MCP verification",
      );
  const verifiedPluginIds = new Set(
    (verifiedPlugins.installed || []).map((entry) => entry.pluginId),
  );
  const mcp = Array.isArray(verifiedMcp)
    ? verifiedMcp.find((entry) => entry.name === mode.mcpName)
    : verifiedMcp?.name === mode.mcpName
      ? verifiedMcp
      : null;
  for (const pluginId of desiredPluginIds) {
    if (!verifiedPluginIds.has(pluginId)) {
      throw new Error(`Codex did not report ${pluginId} installed.`);
    }
  }
  if (!remoteAgent && mcp?.transport?.url !== mode.mcpUrl) {
    throw new Error(
      `Nuanu Flow MCP URL mismatch: expected ${mode.mcpUrl}, found ${
        mcp?.transport?.url || "missing"
      }.`,
    );
  }
  const verifiedAuthenticationReady = remoteAgent
    ? true
    : headerCredentialPresent
    ? authStatus === "environment_credential"
    : mcp.auth_status === "o_auth";
  if (!verifiedAuthenticationReady) {
    throw new Error(
      `Nuanu Flow MCP authentication verification failed: ${mcp.auth_status}.`,
    );
  }
  const hook = await (options.readHookTrustStatus || readHookTrustStatus)({
    codexBin: codexOptions.codexBin,
    cwd: repoRoot,
    env,
    pluginId: remoteAgent ? mode.workerPluginId : mode.pluginId,
    timeoutMs: options.hookStatusTimeoutMs,
  });
  const attachment =
    actions.length > 0 ? "restart_required" : "verification_required";

  return {
    surface: "codex-cli",
    mode: modeName,
    codexVersion: String(version.stdout).trim(),
    codexHome: home,
    pluginId: mode.pluginId,
    pluginIds: desiredPluginIds,
    remoteAgent,
    mcpUrl: mode.mcpUrl,
    authStatus,
    hookStatus: hook.status,
    hookDetail: hook.detail,
    build,
    actions,
    resumeCommand: resumeCommand(env),
    lifecycle: createPluginLifecycle({
      surface: "codex-cli",
      authentication: remoteAgent ? "skipped" : "connected",
      attachment,
      continuation:
        attachment === "restart_required"
          ? "same_thread_resume"
          : "verify_in_current_thread",
    }),
  };
}

function parseArgs(argv) {
  const mode = argv[0];
  if (mode !== "dev" && mode !== "prod") {
    throw new Error(
      "Usage: node scripts/codex/install-current.mjs <dev|prod> [options]",
    );
  }
  const options = { mode };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--remote-agent") options.remoteAgent = true;
    else if (arg === "--codex-bin") {
      options.codexBin = argv[++index];
      if (!options.codexBin) throw new Error("--codex-bin requires a value");
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printReport(report) {
  console.log(`Codex: ${report.codexVersion}`);
  console.log(`Plugin: ${report.pluginId}`);
  if (report.remoteAgent) console.log(`Companion: ${report.pluginIds[1]}`);
  console.log(`MCP: ${report.mcpUrl}`);
  console.log(`Installation: ${report.lifecycle.installation}`);
  console.log(`Authentication: ${report.lifecycle.authentication}`);
  console.log(`Attachment: ${report.lifecycle.attachment}`);
  console.log(
    `Hook: ${
      report.hookStatus === "review_required"
        ? "review required"
        : report.hookStatus
    }`,
  );
  for (const action of report.actions) console.log(action);
  console.log("");
  if (report.hookStatus === "review_required") {
    console.log(
      "On restart, review and trust the Nuanu Flow lifecycle hooks once when Codex asks.",
    );
    console.log("You can also inspect it later with /hooks.");
    console.log("");
  } else if (report.hookStatus === "unsupported") {
    console.log(
      "The lifecycle hooks are unavailable; the resume prompt and MCP instructions will still continue setup.",
    );
    console.log("");
  }
  const action = attachmentAction(report.lifecycle);
  if (action === "restart") {
    console.log("Codex CLI loads new MCP tools at session startup.");
    console.log(
      "Exit Codex, then run this once in the same terminal; setup will continue automatically:",
    );
    console.log("");
    console.log(report.resumeCommand);
  } else if (action === "verify") {
    console.log("Nuanu Flow is installed and OAuth is active.");
    console.log(
      "Tool attachment is a separate host state; verify it with onboarding_next before claiming setup is ready.",
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/codex/install-current.mjs <dev|prod> [options]

Install Nuanu Flow into the current Codex CLI profile, open only the browser
OAuth page, and print the exact command for resuming this conversation after
the CLI restart when newly added MCP tools require it.

Options:
  --force            Force regeneration of the development package.
  --codex-bin PATH   Use a specific Codex executable.
  -h, --help         Show this help.
`);
    return;
  }
  printReport(await installCurrentProfile(options.mode, options));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(`[codex-install-current] ${error.stack || error.message}`);
    process.exit(1);
  });
}
