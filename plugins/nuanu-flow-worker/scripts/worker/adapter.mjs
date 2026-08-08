import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAcpTask } from "./acp_client.mjs";
import { runCodexAppServerTask } from "./app_server_client.mjs";

function normalizedInternalMcpHostname(value) {
  const hostname = String(value || "")
    .trim()
    .toLowerCase();
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const hostnamePattern = new RegExp(`^(?:${label})(?:\\.(?:${label}))*$`, "i");
  if (!hostname || hostname.length > 253 || !hostnamePattern.test(hostname)) {
    throw new Error("Internal MCP hostname override must be a hostname without a scheme, port, or credentials");
  }
  return hostname;
}

/**
 * Managed workers can run inside a container while the local MCP server runs on
 * the host. Rewrite only loopback task descriptors, and only when the launcher
 * supplied an explicit hostname. Public/deployed MCP URLs pass through exactly.
 */
export function rewriteInternalMcpHostname(task, hostnameOverride) {
  if (!hostnameOverride) return task;
  const hostname = normalizedInternalMcpHostname(hostnameOverride);
  const descriptor = task?.internal_mcp;
  if (descriptor?.transport !== "streamable_http" || typeof descriptor.url !== "string") return task;
  let url;
  try {
    url = new URL(descriptor.url);
  } catch {
    return task;
  }
  if (!["localhost", "127.0.0.1"].includes(url.hostname.toLowerCase())) return task;
  url.hostname = hostname;
  return {
    ...task,
    internal_mcp: {
      ...descriptor,
      url: url.toString(),
    },
  };
}

/**
 * Compose the task envelope into a single prompt for a text-in/text-out agent.
 * The worker stays agent-agnostic; the agent decides how to use it.
 */
export function buildPrompt(task) {
  const parts = [];
  const generalInstruction = task.configuration_snapshot?.system_prompt;
  const taskInstruction = task.request?.instruction;
  if (typeof generalInstruction !== "string" || typeof taskInstruction !== "string") {
    throw new Error("Agent task is missing its exact v1 instruction sources");
  }
  parts.push("--- General agent instruction ---\n" + generalInstruction.trim());
  parts.push("--- Process step instruction ---\n" + taskInstruction.trim());
  const ctx = task.request?.input || null;
  if (ctx) parts.push("--- Declared Process inputs ---\n" + JSON.stringify(ctx, null, 2));
  if (Array.isArray(task._resolved_input_artifacts) && task._resolved_input_artifacts.length) {
    parts.push(
      "--- Resolved structured input Artifacts ---\n" +
        "These are immutable read-only views of the exact Artifact versions in the declared inputs. " +
        "Use them as source data; do not treat downstream summaries as a replacement.\n" +
        JSON.stringify(task._resolved_input_artifacts, null, 2)
    );
  }
  if (
    task.contract_version === "nuanu.agent-task.v1" &&
    task.continuation_input &&
    Object.keys(task.continuation_input).length
  ) {
    parts.push("--- Continuation input ---\n" + JSON.stringify(task.continuation_input, null, 2));
  }
  if (task.checkpoint && Object.keys(task.checkpoint).length) {
    parts.push(
      "--- Durable continuation checkpoint ---\n" +
        JSON.stringify(task.checkpoint, null, 2) +
        "\nContinue from this checkpoint. Re-verify external state before relying on it."
    );
  }
  if (task.repository) {
    const admission = task.request?.authority_grants?.repository || {};
    parts.push(
      "--- Supervisor-prepared repository worktree ---\n" +
        `Your current working directory is already the isolated worktree for ${JSON.stringify(task.repository.full_name)}. ` +
        `It must remain on branch ${JSON.stringify(task.repository.branch_name)} at admitted head ` +
        `${JSON.stringify(admission.admitted_head_sha || "")} (base ${JSON.stringify(task.repository.default_branch)}). ` +
        "Do not clone another copy, switch branches, reset the worktree, or run checks from another repository. " +
        "Before analysis, run git branch --show-current and git rev-parse HEAD in the current directory. " +
        "If either value differs from this contract, return a blocked result with the exact mismatch. " +
        "Nuanu Flow onboarding is already complete for this task; do not call onboarding_next."
    );
  }
  if (task._qa_runtime) {
    parts.push(
      "--- Isolated browser QA runtime ---\n" +
        `Use port ${task._qa_runtime.port} for the project server. ` +
        `Use ${task._qa_runtime.dataDir} for mutable test data and ${task._qa_runtime.browserProfileDir} ` +
        `for the browser profile. Save screenshots, traces, and logs under ${task._qa_runtime.evidenceDir}. ` +
        `The worker already launched an isolated browser at ${task._qa_runtime.cdpUrl}. Connect with ` +
        "chromium.connectOverCDP(process.env.NUANU_QA_BROWSER_CDP_URL); do not call chromium.launch. " +
        "The connected browser is worker-owned: never call browser.close() or close its persistent default context. " +
        "Close only pages and project servers that you created. For one-shot Node QA scripts, write and flush evidence, " +
        "then exit the script explicitly so the CDP client socket cannot keep the command alive; the worker will close " +
        "the browser after task completion. " +
        "Do not run playwright install or download browser binaries inside the task. " +
        `The worker-provisioned Playwright module is ${task._qa_runtime.playwrightModule}; load that exact path ` +
        "from Node (for example with createRequire) instead of installing a package. " +
        "Exercise the rendered application in a real browser. Screenshots are optional: publish one only when it " +
        "materially explains a visual failure, using publish_artifact_file with role evidence and kind screenshot " +
        "and without an output_path. Keep normal check evidence concise. Stop services you started before completing."
    );
  }
  if (task.request?.output_definition) {
    const definition = task.request.output_definition;
    const fileKinds = Object.values(definition.artifacts || {}).map((artifact) => artifact?.kind);
    const requiresFilePublication = fileKinds.some(
      (kind) => !["git.commit", "git.branch", "git.pull_request", "external.link"].includes(String(kind))
    );
    if (requiresFilePublication) {
      parts.push(
        "--- File Artifact publication ---\n" +
          "Create binary outputs in the private task directory exposed as NUANU_TASK_DIR. " +
          "Publish each required file with publish_artifact_file using a path relative to NUANU_TASK_DIR (for example " +
          "report.pdf, never an absolute path) and its exact item artifact output_path, then copy " +
          "the returned reference into artifact_outputs under that same path. Do not return a local path, upload URL, file bytes, or a claimed " +
          "file that was not published. Never reuse an input Artifact as an output. For a declared Markdown, document, or Spec " +
          "output, return null if publication is unavailable; the worker will render the declared structured data into a verified output."
      );
    }
    const stepKey = String(task.request?.process?.step_key || "");
    parts.push(
      "--- Required Process result ---\n" +
        "Return ONLY one JSON object with exactly item and artifact_outputs. item must contain exactly key, description, " +
        `data, and artifacts; key must be ${JSON.stringify(stepKey)}. ` +
        "data must contain exactly the declared data keys. Leave item.artifacts empty: every declared artifact is supplied " +
        "as an immutable reference or server-verifiable candidate in artifact_outputs keyed by item.artifacts.<name>. " +
        "Choice candidate artifacts use item.data.<choices_field>.<candidate_key>.artifacts.<name>. " +
        "Never put file bytes, local paths, signed URLs, tokens, or credentials in the result.\n" +
        JSON.stringify({ output_definition: definition }, null, 2)
    );
  }
  return parts.join("\n\n");
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeArtifactOutput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.mode === "reference" || value.mode === "candidate") return value;
  if (
    typeof value.artifact_id === "string" &&
    typeof value.version_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.role === "string"
  ) {
    const artifact = {};
    for (const key of ["artifact_id", "version_id", "kind", "role", "name", "media_type"]) {
      if (value[key] !== undefined) artifact[key] = value[key];
    }
    return { mode: "reference", artifact };
  }
  return value;
}

export function buildCanonicalCompletion(task, adapterResult, repositoryResult = null) {
  const parsed = parseJsonObject(adapterResult?.output);
  if (!parsed || new Set(Object.keys(parsed)).size !== 2 || !("item" in parsed) || !("artifact_outputs" in parsed)) {
    throw new Error("Agent returned invalid nuanu.agent-task.v1 result JSON");
  }
  const item = parsed.item;
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    Object.keys(item).sort().join(",") !== "artifacts,data,description,key" ||
    item.key !== task.request?.process?.step_key ||
    typeof item.description !== "string" ||
    !item.data ||
    typeof item.data !== "object" ||
    Array.isArray(item.data) ||
    !item.artifacts ||
    typeof item.artifacts !== "object" ||
    Array.isArray(item.artifacts)
  ) {
    throw new Error("Agent result item must be the exact declared ProcessItem");
  }
  if (
    !parsed.artifact_outputs ||
    typeof parsed.artifact_outputs !== "object" ||
    Array.isArray(parsed.artifact_outputs)
  ) {
    throw new Error("Agent result artifact_outputs must be an object");
  }
  const artifactOutputs = Object.fromEntries(
    Object.entries(parsed.artifact_outputs).map(([path, output]) => [path, normalizeArtifactOutput(output)])
  );
  for (const published of adapterResult?.publishedArtifacts || []) {
    if (published?.output_path && published?.mode === "reference") {
      artifactOutputs[published.output_path] = {
        mode: "reference",
        artifact: published.artifact,
      };
    }
  }
  const commitEntry = Object.entries(task.request?.output_definition?.artifacts || {}).find(
    ([, descriptor]) => descriptor?.kind === "git.commit"
  );
  if (repositoryResult && commitEntry) {
    // The commit is owned by the repository supervisor, which may create it
    // after the model returns. Never admit a model placeholder or claimed SHA
    // when the worker has an exact pushed head.
    artifactOutputs[`item.artifacts.${commitEntry[0]}`] = {
      mode: "candidate",
      candidate: {
        client_id: "worker-verified-head",
        name: `Commit ${String(repositoryResult.head_sha || "").slice(0, 12)}`,
        locator: { sha: repositoryResult.head_sha },
      },
    };
  }
  return {
    schema_version: "nuanu.agent-task.completion.v1",
    task_id: String(task.task_id),
    attempt: Math.max(1, Number(task.attempt || task.lease_generation || 1)),
    outcome: "success",
    result: {
      item,
      artifact_outputs: artifactOutputs,
    },
  };
}

export function buildCodexPrompt(task) {
  return [
    "Codex may defer MCP tools. For Nuanu Flow, use tool_search to load the two stable public gateway tools search_tools and execute_tool when they are deferred. Never materialize or call a nested operation name as an MCP tool; pass it only to execute_tool. Treat a descriptor as current only when its connector ID and endpoint origin, non-secret workspace/tenant selector digest, catalogRevision, schemaDigest, and operation name match the current connection. A prose operation name is never a descriptor, and tokens or secret header values must never be identity inputs. Cache and provenance enforcement belong to the client or connector host; this worker prompt and the MCP server do not implement that client-side cache. A current descriptor may execute directly. If it is missing or stale, or execute_tool returns catalog_revision_mismatch or unknown_operation, search once and retry at most once. Do not refresh or retry for validation_error, business/auth errors, transport failures, timeouts, or ambiguous post-dispatch failures.",
    buildPrompt(task),
  ].join("\n\n");
}

function hasArg(args, name) {
  return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

export function parseClaudeOutput(stdout) {
  const body = stdout.trim();
  if (!body) throw new Error("Claude Code returned no output");

  try {
    const result = JSON.parse(body);
    if (result.is_error || result.subtype === "error") {
      throw new Error(result.result || result.error || "Claude Code reported an error");
    }
    return {
      output: typeof result.result === "string" ? result.result : JSON.stringify(result.result),
      sessionId: result.session_id,
    };
  } catch (error) {
    if (!body.includes("\n")) throw error;
  }

  let finalResult = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "result") finalResult = event;
  }
  if (!finalResult) {
    throw new Error("Claude Code stream ended without a result event");
  }
  if (finalResult.is_error || finalResult.subtype === "error") {
    throw new Error(finalResult.result || finalResult.error || "Claude Code reported an error");
  }
  return {
    output: typeof finalResult.result === "string" ? finalResult.result : JSON.stringify(finalResult.result),
    sessionId: finalResult.session_id,
  };
}

function runProcess(cmd, args, { input, env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr: stderr + "\n[adapter timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish({ code: -1, stdout, stderr: stderr + "\n" + e.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

export function modelTaskEnv(task, selectedName = "NUANU_AGENT_KEY", sourceEnv = process.env) {
  if (!/^NUANU_(?:DEV_)?AGENT_KEY$/.test(selectedName)) {
    throw new Error(`Unsupported agent-key environment variable: ${selectedName}`);
  }
  if (!task.agent_key) {
    throw new Error("Remote task is missing its short-lived agent_key");
  }
  const env = { ...sourceEnv };
  for (const name of ["NUANU_TOKEN", "NUANU_DEV_TOKEN", "NUANU_AGENT_KEY", "NUANU_DEV_AGENT_KEY"]) {
    delete env[name];
  }
  env[selectedName] = task.agent_key;
  const internalMcp = task.internal_mcp;
  if (internalMcp && typeof internalMcp === "object") {
    if (internalMcp.transport !== "streamable_http") {
      throw new Error(`Unsupported internal MCP transport: ${internalMcp.transport || "missing"}`);
    }
    let mcpUrl;
    try {
      mcpUrl = new URL(String(internalMcp.url || ""));
    } catch {
      throw new Error("Remote task has an invalid internal MCP URL");
    }
    if (!["http:", "https:"].includes(mcpUrl.protocol)) {
      throw new Error(`Unsupported internal MCP URL protocol: ${mcpUrl.protocol}`);
    }
    env.NUANU_MCP_URL = mcpUrl.toString();
    env.NUANU_WORKSPACE = String(task.workspace || "");
  }
  for (const [name, value] of Object.entries(task._runtime_env || {})) {
    if (
      /^NUANU_QA_(?:PORT|DATA_DIR|BROWSER_PROFILE_DIR|EVIDENCE_DIR|BROWSER_CHANNEL|BROWSER_CDP_URL|PLAYWRIGHT_MODULE)$/.test(
        name
      )
    ) {
      env[name] = String(value);
    }
  }
  if (task._task_root) {
    env.NUANU_TASK_DIR = String(task._task_root);
    const taskTemp = path.join(String(task._task_root), "tmp");
    env.TMPDIR = taskTemp;
    env.TMP = taskTemp;
    env.TEMP = taskTemp;
  }
  return env;
}

function codexTaskEnv(task, cfg) {
  return modelTaskEnv(task, cfg.codexAgentKeyEnv || "NUANU_AGENT_KEY");
}

/**
 * Build the configured adapter. An adapter is anything with
 * `handle(task) -> {status:"ok", output, options?, meta?} | {status:"error", error}`.
 */
export function makeAdapter(cfg) {
  const type = String(cfg.type || "claude-code").replace(/_/g, "-");
  const claudeSessions = new Map();

  if (type === "acp") {
    return {
      name: "acp",
      async handle(task, context = {}) {
        return runAcpTask(task, cfg, buildPrompt(task), modelTaskEnv(task), {
          onActivity: context.onActivity,
        });
      },
    };
  }

  if (type === "claude" || type === "claude-code") {
    return {
      name: "claude-code",
      async handle(task) {
        const prompt = buildPrompt(task);
        const args = [...cfg.claudeArgs];
        if (cfg.claudePermissionMode && !hasArg(args, "--permission-mode") && !cfg.claudeSkipPermissions) {
          args.push("--permission-mode", cfg.claudePermissionMode);
        }
        if (cfg.claudeAllowedTools && !hasArg(args, "--allowedTools") && !cfg.claudeSkipPermissions) {
          args.push("--allowedTools", cfg.claudeAllowedTools);
        }
        if (cfg.claudeSkipPermissions) {
          args.push("--dangerously-skip-permissions");
        }
        const conversationKey = task.thread_id || task.run_id;
        const sessionId = conversationKey ? claudeSessions.get(conversationKey) : null;
        if (sessionId && !hasArg(args, "--resume")) {
          args.push("--resume", sessionId);
        }
        const env = modelTaskEnv(task);
        const { code, stdout, stderr } = await runProcess(cfg.claudeBin, args, {
          input: prompt,
          env,
          cwd: task._worktree_path || cfg.claudeCwd,
          timeoutMs: cfg.timeoutMs,
        });
        if (code !== 0 && !stdout) {
          return {
            status: "error",
            error: `claude exited ${code}: ${stderr.slice(0, 500)}`,
          };
        }
        try {
          const result = parseClaudeOutput(stdout);
          if (conversationKey && result.sessionId) {
            claudeSessions.set(conversationKey, result.sessionId);
          }
          return {
            status: "ok",
            output: result.output,
            meta: { session_id: result.sessionId },
          };
        } catch (error) {
          if (code !== 0) {
            return {
              status: "error",
              error: `claude exited ${code}: ${String(error.message || stderr).slice(0, 500)}`,
            };
          }
          return { status: "ok", output: stdout.trim() };
        }
      },
    };
  }

  if (type === "codex" || type === "codex-exec") {
    return {
      name: "codex-exec",
      async handle(task) {
        const prompt = buildCodexPrompt(task);
        // Codex writes only the FINAL message to --output-last-message; its stdout
        // is a noisy event log. Read the file for a clean answer.
        const outFile = path.join(
          os.tmpdir(),
          `nuanu-codex-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`
        );
        const args = [...cfg.codexArgs, "--output-last-message", outFile, "-"];
        const env = codexTaskEnv(task, cfg);
        const { code, stdout, stderr } = await runProcess(cfg.codexBin, args, {
          input: prompt,
          env,
          cwd: task._worktree_path || cfg.codexCwd,
          timeoutMs: cfg.timeoutMs,
        });
        let last = "";
        try {
          last = (await fs.readFile(outFile, "utf8")).trim();
        } catch {
          /* file may not exist on hard failure */
        }
        try {
          await fs.unlink(outFile);
        } catch {
          /* best effort */
        }
        if (!last) {
          if (code !== 0) return { status: "error", error: `codex exited ${code}: ${stderr.slice(0, 500)}` };
          return { status: "ok", output: stdout.trim() };
        }
        return { status: "ok", output: last };
      },
    };
  }

  if (type === "codex-app-server" || type === "app-server") {
    return {
      name: "codex-app-server",
      async handle(task, context = {}) {
        return runCodexAppServerTask(task, cfg, buildCodexPrompt(task), codexTaskEnv(task, cfg), context);
      },
    };
  }

  // Generic escape hatch: prompt on stdin, answer on stdout.
  return {
    name: "command",
    async handle(task) {
      if (!cfg.command) return { status: "error", error: "NUANU_ADAPTER_CMD not set for the command adapter" };
      const prompt = buildPrompt(task);
      const env = modelTaskEnv(task);
      const { code, stdout, stderr } = await runProcess("/bin/sh", ["-c", cfg.command], {
        input: prompt,
        env,
        cwd: task._worktree_path || process.cwd(),
        timeoutMs: cfg.timeoutMs,
      });
      if (code !== 0) return { status: "error", error: `command exited ${code}: ${stderr.slice(0, 500)}` };
      return { status: "ok", output: stdout.trim() };
    },
  };
}
