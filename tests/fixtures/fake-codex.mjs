#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const statePath =
  process.env.FAKE_CODEX_STATE ||
  (process.env.FAKE_CODEX_STATE_DIR && process.env.CODEX_HOME
    ? path.join(
        process.env.FAKE_CODEX_STATE_DIR,
        `${path.basename(process.env.CODEX_HOME)}.json`,
      )
    : "");
const logPath = process.env.FAKE_CODEX_LOG;
if (!statePath || !logPath) {
  console.error(
    "FAKE_CODEX_STATE or FAKE_CODEX_STATE_DIR, plus FAKE_CODEX_LOG, are required",
  );
  process.exit(2);
}
if (
  process.env.FAKE_EXPECT_CODEX_HOME &&
  process.env.CODEX_HOME !== process.env.FAKE_EXPECT_CODEX_HOME
) {
  console.error(
    `expected CODEX_HOME=${process.env.FAKE_EXPECT_CODEX_HOME}; received ${process.env.CODEX_HOME}`,
  );
  process.exit(2);
}

const rawArgs = process.argv.slice(2);
await fs.mkdir(path.dirname(logPath), { recursive: true });
await fs.appendFile(logPath, `${JSON.stringify(rawArgs)}\n`);

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      marketplaces: [],
      installed: [],
      mcpAuth: {},
    };
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function marketplaceFromSource(source, ref) {
  if (source === "nuanu-ai/agent-tools") {
    return {
      name: "nuanu",
      root: "/fake/git/nuanu-ai-agent-tools",
      marketplaceSource: {
        sourceType: "git",
        source,
        ref: ref || null,
      },
    };
  }
  const absolute = path.resolve(source);
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(absolute, ".agents/plugins/marketplace.json"),
      "utf8",
    ),
  );
  return {
    name: manifest.name,
    root: absolute,
    marketplaceSource: {
      sourceType: "local",
      source: absolute,
    },
  };
}

async function pluginVersion(selector, state) {
  const [name, marketplaceName] = selector.split("@");
  const marketplace = state.marketplaces.find(
    (entry) => entry.name === marketplaceName,
  );
  if (!marketplace) throw new Error(`marketplace not found: ${marketplaceName}`);
  if (marketplace.marketplaceSource?.sourceType === "git") return "0.1.0";
  const catalog = JSON.parse(
    await fs.readFile(
      path.join(marketplace.root, ".agents/plugins/marketplace.json"),
      "utf8",
    ),
  );
  const plugin = catalog.plugins.find((entry) => entry.name === name);
  if (!plugin) throw new Error(`plugin not found: ${selector}`);
  const manifest = JSON.parse(
    await fs.readFile(
      path.resolve(
        marketplace.root,
        plugin.source.path,
        ".codex-plugin/plugin.json",
      ),
      "utf8",
    ),
  );
  return manifest.version;
}

function mcpList(state) {
  const dev = state.installed.some(
    (plugin) => plugin.pluginId === "nuanu-flow-dev@nuanu-dev",
  );
  const name = dev ? "flow_dev" : "flow";
  return [
    {
      name,
      enabled: true,
      disabled_reason: null,
      transport: {
        type: "streamable_http",
        url: dev
          ? process.env.NUANU_DEV_MCP_URL || "http://localhost:3001/mcp"
          : "https://flow.nuanu.com/mcp-server/mcp",
        bearer_token_env_var: null,
        http_headers: null,
        env_http_headers: dev
          ? {
              "X-Plane-User-Token": "NUANU_DEV_TOKEN",
              "X-Agent-Key": "NUANU_DEV_AGENT_KEY",
              "X-Plane-Workspace": "NUANU_DEV_WORKSPACE",
            }
          : {
              "X-Plane-User-Token": "NUANU_TOKEN",
              "X-Agent-Key": "NUANU_AGENT_KEY",
              "X-Plane-Workspace": "NUANU_WORKSPACE",
            },
      },
      startup_timeout_sec: 20,
      tool_timeout_sec: 120,
      auth_status: state.mcpAuth?.[name] || "unsupported",
    },
  ];
}

try {
  const args = rawArgs;
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    console.log("codex-cli 0.145.0");
    process.exit(0);
  }

  const state = await loadState();
  if (args[0] === "plugin" && args[1] === "marketplace") {
    const command = args[2];
    if (command === "list") {
      output({ marketplaces: state.marketplaces });
    } else if (command === "add") {
      const source = args[3];
      const refIndex = args.indexOf("--ref");
      const entry = await marketplaceFromSource(
        source,
        refIndex >= 0 ? args[refIndex + 1] : "",
      );
      state.marketplaces = state.marketplaces.filter(
        (marketplace) => marketplace.name !== entry.name,
      );
      state.marketplaces.push(entry);
      await saveState(state);
      output({ added: entry });
    } else if (command === "remove") {
      const name = args[3];
      state.marketplaces = state.marketplaces.filter(
        (marketplace) => marketplace.name !== name,
      );
      await saveState(state);
      output({ removed: name });
    } else if (command === "upgrade") {
      output({ upgraded: args[3] || "all" });
    } else {
      throw new Error(`unsupported marketplace command: ${command}`);
    }
  } else if (args[0] === "plugin") {
    const command = args[1];
    if (command === "add") {
      const selector = args[2];
      const version = await pluginVersion(selector, state);
      const [name, marketplaceName] = selector.split("@");
      state.installed = state.installed.filter(
        (plugin) => plugin.pluginId !== selector,
      );
      state.installed.push({
        pluginId: selector,
        name,
        marketplaceName,
        version,
        installed: true,
        enabled: true,
      });
      await saveState(state);
      output({ installed: selector, version });
    } else if (command === "list") {
      output({ installed: state.installed, available: [] });
    } else if (command === "remove") {
      const selector = args[2];
      state.installed = state.installed.filter(
        (plugin) => plugin.pluginId !== selector,
      );
      await saveState(state);
      output({ removed: selector });
    } else {
      throw new Error(`unsupported plugin command: ${command}`);
    }
  } else if (args[0] === "mcp" && args[1] === "list") {
    output(mcpList(state));
  } else if (args[0] === "mcp" && args[1] === "login") {
    const name = args[2];
    state.mcpAuth ||= {};
    state.mcpAuth[name] = "o_auth";
    await saveState(state);
    output({ loggedIn: name });
  } else {
    throw new Error(`unsupported fake Codex args: ${rawArgs.join(" ")}`);
  }
} catch (error) {
  console.error(`[fake-codex] ${error.message}`);
  process.exit(1);
}
