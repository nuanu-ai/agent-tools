#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const CODEX_TOP_LEVEL_FIELDS = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "hooks",
  "mcpServers",
  "apps",
  "interface",
]);

const CODEX_INTERFACE_FIELDS = new Set([
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "websiteURL",
  "privacyPolicyURL",
  "termsOfServiceURL",
  "defaultPrompt",
  "brandColor",
  "composerIcon",
  "logo",
  "logoDark",
  "screenshots",
]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--codex-plugin") {
      options.codexPlugin = argv[++index];
      if (!options.codexPlugin) {
        throw new Error("--codex-plugin requires a path");
      }
    } else if (arg === "--codex-marketplace") {
      options.codexMarketplace = argv[++index];
      if (!options.codexMarketplace) {
        throw new Error("--codex-marketplace requires a path");
      }
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function add(message) {
  errors.push(message);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    add(`${label} must contain valid JSON: ${e.message}`);
    return null;
  }
}

function requireString(obj, key, label) {
  if (typeof obj?.[key] !== "string" || !obj[key].trim()) {
    add(`${label} field ${key} must be a non-empty string`);
    return "";
  }
  return obj[key];
}

function requireHttpsUrl(value, label) {
  if (value == null) return;
  if (typeof value !== "string" || !value.startsWith("https://")) {
    add(`${label} must be an absolute https:// URL`);
  }
}

function requireRelativePath(value, label) {
  if (typeof value !== "string" || !value.startsWith("./") || path.isAbsolute(value)) {
    add(`${label} must be a relative path beginning with ./`);
  }
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateNoUnknownFields(obj, allowed, label) {
  for (const key of Object.keys(obj || {})) {
    if (!allowed.has(key)) add(`${label} field ${key} is not supported`);
  }
}

function validateMcpServers(servers, label) {
  if (!isObject(servers)) {
    add(`${label} must be an object`);
    return;
  }
  for (const [name, server] of Object.entries(servers)) {
    if (!name.trim()) add(`${label} server names must be non-empty`);
    if (!isObject(server)) {
      add(`${label} server ${name} must be an object`);
      continue;
    }
    if (server.type && !["http", "streamable_http", "sse", "stdio"].includes(server.type)) {
      add(`${label} server ${name} has unsupported type ${server.type}`);
    }
    if ((server.type === "http" || server.type === "streamable_http" || server.type === "sse") && !server.url) {
      add(`${label} server ${name} must declare url`);
    }
    if (server.url && !/^https?:\/\//.test(server.url) && !server.url.includes("${")) {
      add(`${label} server ${name} url must be http(s) or host interpolation syntax`);
    }
    if (server.default_tools_approval_mode && !["auto", "prompt", "writes", "approve"].includes(server.default_tools_approval_mode)) {
      add(`${label} server ${name} default_tools_approval_mode is invalid`);
    }
    if (server.env_http_headers && !isObject(server.env_http_headers)) {
      add(`${label} server ${name} env_http_headers must be an object`);
    }
    if (server.headers && !isObject(server.headers)) {
      add(`${label} server ${name} headers must be an object`);
    }
  }
}

async function validateApps(pluginRoot, appsPath) {
  if (appsPath !== "./.app.json") {
    add("Codex plugin apps path must resolve to .app.json");
    return;
  }
  const appManifest = await readJson(path.join(pluginRoot, ".app.json"), "Codex app companion");
  if (!isObject(appManifest?.apps) || Object.keys(appManifest.apps).length === 0) {
    add("Codex app companion apps must be a non-empty object");
    return;
  }
  for (const [alias, app] of Object.entries(appManifest.apps)) {
    if (!alias.trim() || !isObject(app)) {
      add("Codex app companion entries must have non-empty aliases and object values");
      continue;
    }
    if (
      typeof app.id !== "string" ||
      !/^(asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(app.id)
    ) {
      add(`Codex app companion ${alias} has an invalid app id`);
    }
  }
}

async function validateSkills(pluginRoot, skillsPath) {
  requireRelativePath(skillsPath, "Codex plugin skills path");
  const root = path.resolve(pluginRoot, skillsPath || "./skills");
  if (!(await exists(root))) {
    add(`skills directory does not exist: ${path.relative(repoRoot, root)}`);
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillFile = path.join(root, entry.name, "SKILL.md");
    if (!(await exists(skillFile))) {
      add(`skill ${entry.name} is missing SKILL.md`);
      continue;
    }
    const body = await fs.readFile(skillFile, "utf8");
    if (!body.startsWith("---\n") || body.indexOf("\n---", 4) === -1) {
      add(`skill ${entry.name} must start with closed YAML frontmatter`);
    }
    if (!/^name:\s*\S+/m.test(body)) add(`skill ${entry.name} frontmatter must include name`);
    if (!/^description:\s*\S+/m.test(body)) add(`skill ${entry.name} frontmatter must include description`);
  }
}

function resolveInside(root, relativePath, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  add(`${label} must stay inside the plugin root`);
  return null;
}

async function validateHooks(pluginRoot, hooksPath) {
  requireRelativePath(hooksPath, "Codex plugin hooks path");
  const configPath = resolveInside(
    pluginRoot,
    hooksPath || "./hooks/hooks.json",
    "Codex plugin hooks path",
  );
  if (!configPath) return;
  if (!(await exists(configPath))) {
    add(`hooks config does not exist: ${path.relative(repoRoot, configPath)}`);
    return;
  }
  const config = await readJson(configPath, "Codex hooks config");
  const sessionStart = config?.hooks?.SessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length !== 1) {
    add("Codex hooks config must define exactly one SessionStart matcher group");
    return;
  }
  const group = sessionStart[0];
  if (group?.matcher !== "startup|resume|clear|compact") {
    add(
      "Codex SessionStart matcher must be startup|resume|clear|compact",
    );
  }
  if (!Array.isArray(group?.hooks) || group.hooks.length !== 1) {
    add("Codex SessionStart must define exactly one command hook");
    return;
  }
  const hook = group.hooks[0];
  if (hook?.type !== "command") {
    add("Codex SessionStart hook type must be command");
  }
  if (
    typeof hook?.timeout !== "number" ||
    !Number.isFinite(hook.timeout) ||
    hook.timeout <= 0 ||
    hook.timeout > 1
  ) {
    add("Codex SessionStart hook timeout must be greater than zero and at most one second");
  }
  if (typeof hook?.command !== "string") {
    add("Codex SessionStart hook command must be a string");
    return;
  }
  const target = hook.command.match(
    /\$\{PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/,
  )?.[1];
  if (!target) {
    add("Codex SessionStart hook command must target a file under ${PLUGIN_ROOT}");
    return;
  }
  const targetPath = resolveInside(
    pluginRoot,
    target,
    "Codex SessionStart hook target",
  );
  if (targetPath && !(await exists(targetPath))) {
    add(
      `Codex SessionStart hook target does not exist: ${path.relative(repoRoot, targetPath)}`,
    );
  }

  const userPromptSubmit = config?.hooks?.UserPromptSubmit;
  if (
    !Array.isArray(userPromptSubmit) ||
    userPromptSubmit.length !== 1
  ) {
    add(
      "Codex hooks config must define exactly one UserPromptSubmit matcher group",
    );
    return;
  }
  const promptGroup = userPromptSubmit[0];
  if (promptGroup?.matcher != null) {
    add("Codex UserPromptSubmit must not define an ignored matcher");
  }
  if (
    !Array.isArray(promptGroup?.hooks) ||
    promptGroup.hooks.length !== 1
  ) {
    add("Codex UserPromptSubmit must define exactly one command hook");
    return;
  }
  const promptHook = promptGroup.hooks[0];
  if (promptHook?.type !== "command") {
    add("Codex UserPromptSubmit hook type must be command");
  }
  if (
    typeof promptHook?.timeout !== "number" ||
    !Number.isFinite(promptHook.timeout) ||
    promptHook.timeout <= 0 ||
    promptHook.timeout > 1
  ) {
    add(
      "Codex UserPromptSubmit hook timeout must be greater than zero and at most one second",
    );
  }
  if (
    typeof promptHook?.additionalContextLimit !== "number" ||
    !Number.isFinite(promptHook.additionalContextLimit) ||
    promptHook.additionalContextLimit <= 0 ||
    promptHook.additionalContextLimit > 500
  ) {
    add(
      "Codex UserPromptSubmit additionalContextLimit must be between 1 and 500",
    );
  }
  if (typeof promptHook?.command !== "string") {
    add("Codex UserPromptSubmit hook command must be a string");
    return;
  }
  const promptTarget = promptHook.command.match(
    /\$\{PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/,
  )?.[1];
  if (!promptTarget) {
    add(
      "Codex UserPromptSubmit hook command must target a file under ${PLUGIN_ROOT}",
    );
    return;
  }
  const promptTargetPath = resolveInside(
    pluginRoot,
    promptTarget,
    "Codex UserPromptSubmit hook target",
  );
  if (promptTargetPath && !(await exists(promptTargetPath))) {
    add(
      `Codex UserPromptSubmit hook target does not exist: ${path.relative(repoRoot, promptTargetPath)}`,
    );
  }
}

async function validateCodexPlugin(pluginRoot) {
  const manifestPath = path.join(pluginRoot, ".codex-plugin/plugin.json");
  const manifest = await readJson(manifestPath, "Codex plugin manifest");
  if (!manifest) return null;

  validateNoUnknownFields(manifest, CODEX_TOP_LEVEL_FIELDS, "Codex plugin manifest");
  requireString(manifest, "name", "Codex plugin manifest");
  const version = requireString(manifest, "version", "Codex plugin manifest");
  if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
    add("Codex plugin manifest version must be semver");
  }
  requireString(manifest, "description", "Codex plugin manifest");
  if (!isObject(manifest.author)) add("Codex plugin manifest author must be an object");
  else requireString(manifest.author, "name", "Codex plugin manifest author");
  requireHttpsUrl(manifest.homepage, "Codex plugin homepage");
  requireHttpsUrl(manifest.repository, "Codex plugin repository");

  if (manifest.skills) await validateSkills(pluginRoot, manifest.skills);
  if (manifest.hooks) {
    if (typeof manifest.hooks !== "string") {
      add("Codex plugin hooks must be a single relative path");
    } else {
      await validateHooks(pluginRoot, manifest.hooks);
    }
  }

  if (manifest.apps) {
    if (typeof manifest.apps !== "string") {
      add("Codex plugin apps must be a single relative path");
    } else {
      await validateApps(pluginRoot, manifest.apps);
    }
  }

  if (typeof manifest.mcpServers === "string") {
    if (manifest.mcpServers.replace(/^\.\//, "") !== ".mcp.json") {
      add("Codex plugin string mcpServers path must resolve to .mcp.json");
    }
    const mcp = await readJson(path.join(pluginRoot, ".mcp.json"), "Codex MCP companion");
    validateMcpServers(mcp?.mcpServers, "Codex MCP companion mcpServers");
  } else if (manifest.mcpServers !== undefined) {
    validateMcpServers(manifest.mcpServers, "Codex plugin manifest mcpServers");
  }

  if (!isObject(manifest.interface)) {
    add("Codex plugin manifest interface must be an object");
    return manifest;
  }
  validateNoUnknownFields(manifest.interface, CODEX_INTERFACE_FIELDS, "Codex plugin interface");
  for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    requireString(manifest.interface, key, "Codex plugin interface");
  }
  if (!Array.isArray(manifest.interface.capabilities) || manifest.interface.capabilities.length === 0) {
    add("Codex plugin interface capabilities must be a non-empty array");
  }
  if (manifest.interface.defaultPrompt) {
    if (!Array.isArray(manifest.interface.defaultPrompt)) add("Codex plugin interface defaultPrompt must be an array");
    else if (manifest.interface.defaultPrompt.length > 3) add("Codex plugin interface defaultPrompt may include at most 3 entries");
  }
  for (const key of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    requireHttpsUrl(manifest.interface[key], `Codex plugin interface ${key}`);
  }
  return manifest;
}

async function validateCodexMarketplace(marketplacePath) {
  const marketplace = await readJson(marketplacePath, "Codex marketplace");
  if (!marketplace) return null;
  const marketplaceRoot = path.resolve(path.dirname(marketplacePath), "../..");
  requireString(marketplace, "name", "Codex marketplace");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    add("Codex marketplace plugins must be a non-empty array");
    return marketplace;
  }
  for (const plugin of marketplace.plugins) {
    requireString(plugin, "name", "Codex marketplace plugin");
    if (!isObject(plugin.source)) add(`Codex marketplace plugin ${plugin.name} source must be an object`);
    else {
      if (plugin.source.source !== "local") add(`Codex marketplace plugin ${plugin.name} source.source must be local`);
      requireRelativePath(plugin.source.path, `Codex marketplace plugin ${plugin.name} source.path`);
      if (!(await exists(path.resolve(marketplaceRoot, plugin.source.path)))) {
        add(`Codex marketplace plugin ${plugin.name} source path does not exist`);
      }
    }
    if (!isObject(plugin.policy)) add(`Codex marketplace plugin ${plugin.name} policy must be an object`);
    else {
      if (!["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(plugin.policy.installation)) {
        add(`Codex marketplace plugin ${plugin.name} policy.installation is invalid`);
      }
      if (!["ON_INSTALL", "ON_USE"].includes(plugin.policy.authentication)) {
        add(`Codex marketplace plugin ${plugin.name} policy.authentication is invalid`);
      }
    }
  }
  return marketplace;
}

function validateDevelopmentPackage(manifest, marketplace) {
  if (manifest?.name !== "nuanu-flow-dev") return;
  if (!manifest.interface?.displayName?.includes("[DEV]")) {
    add("Codex development plugin displayName must contain [DEV]");
  }
  if (marketplace?.name !== "nuanu-dev") {
    add("Codex development marketplace name must be nuanu-dev");
  }
  const serverNames = Object.keys(manifest.mcpServers || {});
  if (serverNames.length !== 1 || serverNames[0] !== "nuanu-flow") {
    add("Codex development plugin must define only MCP server nuanu-flow");
    return;
  }
  const server = manifest.mcpServers["nuanu-flow"];
  try {
    const hostname = new URL(server.url).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      add("Codex development MCP URL must use localhost or loopback");
    }
  } catch {
    add("Codex development MCP URL must be a valid localhost URL");
  }
  for (const variable of Object.values(server.env_http_headers || {})) {
    if (!String(variable).startsWith("NUANU_DEV_")) {
      add(
        "Codex development MCP env header variables must start with NUANU_DEV_",
      );
    }
  }
}

async function validateClaudePlugin(pluginRoot) {
  const manifest = await readJson(path.join(pluginRoot, ".claude-plugin/plugin.json"), "Claude plugin manifest");
  if (!manifest) return null;
  for (const key of ["name", "displayName", "description", "repository", "license"]) {
    requireString(manifest, key, "Claude plugin manifest");
  }
  if (!isObject(manifest.author)) add("Claude plugin manifest author must be an object");
  else requireString(manifest.author, "name", "Claude plugin manifest author");

  const mcpPath = path.join(pluginRoot, ".mcp.json");
  const mcp = (await exists(mcpPath))
    ? await readJson(mcpPath, "Claude MCP config")
    : null;
  if (mcp) validateMcpServers(mcp.mcpServers, "Claude MCP config mcpServers");
  return { manifest, mcp };
}

function defaultInterpolatedValue(value) {
  if (typeof value !== "string") return value;
  return value.match(/^\$\{[^:}]+:-([^}]+)\}$/)?.[1] || value;
}

async function validateProductionHostParity(
  pluginRoot,
  codexManifest,
  claudePlugin,
) {
  const claudeManifest = claudePlugin?.manifest;
  if (
    codexManifest?.name !== "nuanu-flow" ||
    claudeManifest?.name !== "nuanu-flow"
  ) {
    return;
  }

  if (codexManifest.version !== claudeManifest.version) {
    add(
      `Codex and Claude plugin versions must match (${codexManifest.version} != ${claudeManifest.version})`,
    );
  }
  if (codexManifest.repository !== claudeManifest.repository) {
    add("Codex and Claude plugin repositories must match");
  }

  const codexServers = Object.values(codexManifest.mcpServers || {});
  const claudeServers = Object.values(
    claudePlugin?.mcp?.mcpServers || {},
  );
  const codexUrl = codexServers[0]?.url;
  const claudeUrl = defaultInterpolatedValue(claudeServers[0]?.url);
  if (
    codexServers.length !== 1 ||
    claudeServers.length !== 1 ||
    codexUrl !== claudeUrl
  ) {
    add(
      `Codex and Claude production MCP endpoints must match (${String(
        codexUrl || "missing",
      )} != ${String(claudeUrl || "missing")})`,
    );
  }
  for (const url of [codexUrl, claudeUrl]) {
    if (
      typeof url === "string" &&
      /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/.test(url)
    ) {
      add("Production plugin manifests must not contain a localhost MCP URL");
    }
  }

  const activeGuidance = [
    "README.md",
    "plugins/nuanu-flow/README.md",
    "plugins/nuanu-flow/skills/codex-setup/SKILL.md",
    "plugins/nuanu-flow/skills/nuanu-flow/SKILL.md",
  ];
  for (const relative of activeGuidance) {
    const body = await fs.readFile(path.join(repoRoot, relative), "utf8");
    if (/(?:~?149 tools|reopen_required)/.test(body)) {
      add(`${relative} contains a stale tool count or lifecycle state`);
    }
  }

  const readme = await fs.readFile(
    path.join(pluginRoot, "README.md"),
    "utf8",
  );
  for (const expected of [
    "/reload-plugins",
    "attachment: new_session_required",
    "attachment: restart_required",
    "onboarding_next",
  ]) {
    if (!readme.includes(expected)) {
      add(`Plugin README must document ${expected}`);
    }
  }

  const orientation = await fs.readFile(
    path.join(pluginRoot, "skills/nuanu-flow/SKILL.md"),
    "utf8",
  );
  if (
    orientation.includes("→ **Work items**") ||
    orientation.includes("- Work items have:")
  ) {
    add("Nuanu Flow orientation must use the product term Flow items");
  }
  const productCopy = [
    ...(codexManifest.interface?.defaultPrompt || []),
    claudeManifest.description || "",
  ].join("\n");
  if (/\bwork items?\b/i.test(productCopy)) {
    add("Host-facing plugin copy must use the product term Flow items");
  }

  const setupCommand = await fs.readFile(
    path.join(pluginRoot, "commands/setup.md"),
    "utf8",
  );
  if (
    setupCommand.includes("printf '%.10s'") ||
    setupCommand.includes("ready-to-paste `export")
  ) {
    add("Setup guidance must not print secret prefixes or unsolicited exports");
  }
  if (!setupCommand.includes("`nuanu-flow` MCP server")) {
    add("Setup guidance must use the canonical nuanu-flow MCP server name");
  }
}

async function validateClaudeMarketplace() {
  const marketplace = await readJson(path.join(repoRoot, ".claude-plugin/marketplace.json"), "Claude marketplace");
  if (!marketplace) return;
  requireString(marketplace, "name", "Claude marketplace");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    add("Claude marketplace plugins must be a non-empty array");
    return;
  }
  for (const plugin of marketplace.plugins) {
    requireString(plugin, "name", "Claude marketplace plugin");
    requireString(plugin, "source", `Claude marketplace plugin ${plugin.name}`);
    if (!(await exists(path.resolve(repoRoot, plugin.source)))) {
      add(`Claude marketplace plugin ${plugin.name} source path does not exist`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/validate-plugins.mjs [options]

Options:
  --codex-plugin PATH       Validate this Codex plugin root.
  --codex-marketplace PATH  Validate this Codex marketplace JSON.
  -h, --help                Show this help.
`);
    return;
  }
  const pluginRoot = path.resolve(
    options.codexPlugin || path.join(repoRoot, "plugins/nuanu-flow"),
  );
  const marketplacePath = path.resolve(
    options.codexMarketplace ||
      path.join(repoRoot, ".agents/plugins/marketplace.json"),
  );
  const manifest = await validateCodexPlugin(pluginRoot);
  const marketplace = await validateCodexMarketplace(marketplacePath);
  validateDevelopmentPackage(manifest, marketplace);
  const claudePlugin = await validateClaudePlugin(pluginRoot);
  await validateProductionHostParity(pluginRoot, manifest, claudePlugin);
  await validateClaudeMarketplace();

  if (errors.length) {
    console.error("Plugin validation failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Plugin validation passed.");
}

main().catch((e) => {
  console.error(`[validate-plugins] ${e.stack || e.message}`);
  process.exit(1);
});
