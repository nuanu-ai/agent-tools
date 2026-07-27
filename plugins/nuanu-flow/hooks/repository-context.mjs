import fs from "node:fs/promises";
import path from "node:path";

export const CONFIG_FILENAME = ".nuanu-flow.json";
export const LOCAL_CONFIG_FILENAME = ".nuanu-flow.local.json";
export const MAX_CONFIG_BYTES = 4 * 1024;
export const MAX_ANCESTORS = 64;

const ROOT_KEYS = new Set([
  "$schema",
  "version",
  "workspace_slug",
  "project_identifier",
  "scopes",
]);
const SCOPE_KEYS = new Set(["path", "project_identifier"]);
const WORKSPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const PROJECT_IDENTIFIER = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const SCOPE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function normalizeScopePath(value) {
  if (value === ".") return ".";
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    return "";
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !SCOPE_SEGMENT.test(segment),
    )
  ) {
    return "";
  }
  return segments.join("/");
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length > 64) return null;
  const scopes = [];
  for (const scope of value) {
    if (
      !isPlainObject(scope) ||
      !hasOnlyKeys(scope, SCOPE_KEYS) ||
      !PROJECT_IDENTIFIER.test(scope.project_identifier ?? "")
    ) {
      return null;
    }
    const scopePath = normalizeScopePath(scope.path);
    if (!scopePath) return null;
    scopes.push({
      path: scopePath,
      project_identifier: scope.project_identifier,
    });
  }
  return scopes;
}

function normalizeConfig(value, { partial = false } = {}) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ROOT_KEYS)) return null;
  if (
    Object.hasOwn(value, "$schema") &&
    (typeof value.$schema !== "string" ||
      value.$schema.length === 0 ||
      value.$schema.length > 500)
  ) {
    return null;
  }
  if ((!partial || Object.hasOwn(value, "version")) && value.version !== 1) {
    return null;
  }
  if (
    (!partial || Object.hasOwn(value, "workspace_slug")) &&
    !WORKSPACE_SLUG.test(value.workspace_slug ?? "")
  ) {
    return null;
  }
  if (
    (!partial || Object.hasOwn(value, "project_identifier")) &&
    !PROJECT_IDENTIFIER.test(value.project_identifier ?? "")
  ) {
    return null;
  }

  const normalized = {};
  for (const key of [
    "$schema",
    "version",
    "workspace_slug",
    "project_identifier",
  ]) {
    if (Object.hasOwn(value, key)) normalized[key] = value[key];
  }
  if (Object.hasOwn(value, "scopes")) {
    const scopes = normalizeScopes(value.scopes);
    if (!scopes) return null;
    normalized.scopes = scopes;
  }
  return normalized;
}

async function readConfig(filePath, options) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    return normalizeConfig(
      JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
      options,
    );
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function hasGitMarker(directory) {
  try {
    const stat = await fs.stat(path.join(directory, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export async function findGitRoot(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  let current = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (await hasGitMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function matchingScope(scopes, relativeDirectory) {
  let match = null;
  for (const scope of scopes ?? []) {
    const matches =
      scope.path === "." ||
      relativeDirectory === scope.path ||
      relativeDirectory.startsWith(`${scope.path}/`);
    if (
      matches &&
      (!match ||
        (scope.path === "." ? 0 : scope.path.split("/").length) >
          (match.path === "." ? 0 : match.path.split("/").length))
    ) {
      match = scope;
    }
  }
  return match;
}

export async function resolveRepositoryContext(cwd) {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) return null;

  const base = await readConfig(path.join(repoRoot, CONFIG_FILENAME));
  if (!base) return null;

  const local = await readConfig(path.join(repoRoot, LOCAL_CONFIG_FILENAME), {
    partial: true,
  });
  const config = local ? { ...base, ...local } : base;
  const relativeDirectory =
    path.relative(repoRoot, path.resolve(cwd)).split(path.sep).join("/") || ".";
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith("../") ||
    path.isAbsolute(relativeDirectory)
  ) {
    return null;
  }

  const scope = matchingScope(config.scopes, relativeDirectory);
  return {
    repoRoot,
    workspaceSlug: config.workspace_slug,
    projectIdentifier:
      scope?.project_identifier ?? config.project_identifier,
    scopePath: scope?.path ?? "",
    source: local ? LOCAL_CONFIG_FILENAME : CONFIG_FILENAME,
  };
}

export function repositoryContextMessage(binding) {
  if (!binding) return "";
  const scope = binding.scopePath ? ` for scope "${binding.scopePath}"` : "";
  return `Repository binding${scope}: workspace "${binding.workspaceSlug}", project "${binding.projectIdentifier}". Use it as the Flow default unless the user explicitly selects another target; validate it lazily on the first Flow operation.`;
}
