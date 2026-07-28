import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCodexAppServerTask } from "./app_server_client.mjs";

/**
 * Compose the task envelope into a single prompt for a text-in/text-out agent.
 * The worker stays agent-agnostic; the agent decides how to use it.
 */
export function buildPrompt(task) {
  const parts = [];
  if (task.system_prompt) parts.push(String(task.system_prompt).trim());
  if (task.instruction) parts.push(String(task.instruction).trim());
  const ctx = task.context && Object.keys(task.context).length ? task.context : null;
  if (ctx) parts.push("--- Process context ---\n" + JSON.stringify(ctx, null, 2));
  if (task.output_schema) {
    parts.push("Return ONLY a JSON object matching this schema (no prose):\n" + JSON.stringify(task.output_schema));
  }
  return parts.join("\n\n");
}

export function buildCodexPrompt(task) {
  return [
    "Codex defers MCP tools. When the task needs an MCP tool, use tool_search to find and load it before calling it.",
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
          cwd: cfg.claudeCwd,
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
          cwd: cfg.codexCwd,
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
        return runCodexAppServerTask(
          task,
          cfg,
          buildCodexPrompt(task),
          codexTaskEnv(task, cfg),
          context,
        );
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
        cwd: process.cwd(),
        timeoutMs: cfg.timeoutMs,
      });
      if (code !== 0) return { status: "error", error: `command exited ${code}: ${stderr.slice(0, 500)}` };
      return { status: "ok", output: stdout.trim() };
    },
  };
}
