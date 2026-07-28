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
  return value ? path.resolve(value) : "";
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
  const repoRoot = options.repoRoot || REPO_ROOT;
  const buildRoot = path.resolve(options.buildRoot || DEFAULT_BUILD_ROOT);
  const home = path.resolve(
    resolveCodexHome({
      codexHome: options.codexHome,
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
  const conflictingPlugin = installed.find(
    (plugin) => plugin.pluginId === otherMode.pluginId,
  );

  if (conflictingPlugin) {
    const authStatus = await readMcpAuthStatus(otherMode.name, {
      ...options,
      home,
      env,
    });
    if (authStatus === "o_auth") {
      runCodex(["mcp", "logout", mode.mcpName], codexOptions);
      actions.push(`logged out ${otherMode.label.toLowerCase()} OAuth`);
    }
    runCodex(
      ["plugin", "remove", conflictingPlugin.pluginId, "--json"],
      codexOptions,
    );
    actions.push(`removed conflicting ${conflictingPlugin.pluginId}`);
  }

  const marketplace = marketplaces.find(
    (entry) => entry.name === mode.marketplace,
  );
  const selectedPlugin = installed.find(
    (plugin) => plugin.pluginId === mode.pluginId,
  );
  let installPlugin = !selectedPlugin;

  if (modeName === "dev") {
    if (marketplace && !isOwnedDevelopmentMarketplace(marketplace, buildRoot)) {
      throw new Error(
        "Refusing to replace a foreign marketplace named nuanu-dev.",
      );
    }
    const installedVersion = selectedPlugin?.version || "";
    if (marketplace && installedVersion !== build.version) {
      if (selectedPlugin) {
        runCodex(["plugin", "remove", mode.pluginId, "--json"], codexOptions);
        actions.push(`removed outdated ${mode.pluginId}`);
      }
      runCodex(
        ["plugin", "marketplace", "remove", mode.marketplace, "--json"],
        codexOptions,
      );
      actions.push(`refreshed ${mode.marketplace} marketplace`);
      installPlugin = true;
    }
    if (!marketplace || installedVersion !== build.version) {
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
    installPlugin = true;
  }

  if (installPlugin) {
    await runCodexWithBrowserAuth(
      ["plugin", "add", mode.pluginId, "--json"],
      {
        ...options,
        cwd: repoRoot,
        env,
        home,
      },
    );
    actions.push(`installed ${mode.pluginId}`);
  }

  let authStatus = await readMcpAuthStatus(modeName, {
    ...options,
    home,
    env,
  });
  if (authStatus === "not_logged_in") {
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
  if (authStatus !== "o_auth") {
    throw new Error(
      `Nuanu Flow OAuth did not become ready (status: ${authStatus}).`,
    );
  }

  const verifiedPlugins = parseJson(
    runCodex(["plugin", "list", "--available", "--json"], codexOptions)
      .stdout,
    "Codex plugin verification",
  );
  const verifiedMcp = parseJson(
    runCodex(["mcp", "list", "--json"], codexOptions).stdout,
    "Codex MCP verification",
  );
  const plugin = (verifiedPlugins.installed || []).find(
    (entry) => entry.pluginId === mode.pluginId,
  );
  const mcp = Array.isArray(verifiedMcp)
    ? verifiedMcp.find((entry) => entry.name === mode.mcpName)
    : null;
  if (!plugin) throw new Error(`Codex did not report ${mode.pluginId} installed.`);
  if (mcp?.transport?.url !== mode.mcpUrl) {
    throw new Error(
      `Nuanu Flow MCP URL mismatch: expected ${mode.mcpUrl}, found ${
        mcp?.transport?.url || "missing"
      }.`,
    );
  }
  if (mcp.auth_status !== "o_auth") {
    throw new Error(
      `Nuanu Flow MCP authentication verification failed: ${mcp.auth_status}.`,
    );
  }
  const hook = await (options.readHookTrustStatus || readHookTrustStatus)({
    codexBin: codexOptions.codexBin,
    cwd: repoRoot,
    env,
    pluginId: mode.pluginId,
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
    mcpUrl: mode.mcpUrl,
    authStatus: mcp.auth_status,
    hookStatus: hook.status,
    hookDetail: hook.detail,
    build,
    actions,
    resumeCommand: resumeCommand(env),
    lifecycle: createPluginLifecycle({
      surface: "codex-cli",
      authentication: "connected",
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
