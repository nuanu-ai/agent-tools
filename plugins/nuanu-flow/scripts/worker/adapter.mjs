import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    parts.push(
      "Return ONLY a JSON object matching this schema (no prose):\n" +
        JSON.stringify(task.output_schema)
    );
  }
  return parts.join("\n\n");
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

/**
 * Build the configured adapter. An adapter is anything with
 * `handle(task) -> {status:"ok", output, options?, meta?} | {status:"error", error}`.
 */
export function makeAdapter(cfg) {
  if (cfg.type === "claude") {
    return {
      name: "claude",
      async handle(task) {
        const prompt = buildPrompt(task);
        const args = [...cfg.claudeArgs];
        if (cfg.claudeSkipPermissions) args.push("--dangerously-skip-permissions");
        const env = { ...process.env };
        // The per-task key lets the agent's own MCP/API writes attribute to it.
        if (task.agent_key) env.NUANU_AGENT_KEY = task.agent_key;
        const { code, stdout, stderr } = await runProcess(cfg.claudeBin, args, {
          input: prompt,
          env,
          cwd: cfg.claudeCwd,
          timeoutMs: cfg.timeoutMs,
        });
        if (code !== 0 && !stdout) {
          return { status: "error", error: `claude exited ${code}: ${stderr.slice(0, 500)}` };
        }
        // `claude -p --output-format json` prints one JSON object with a `result`.
        try {
          const j = JSON.parse(stdout);
          if (j.is_error) return { status: "error", error: j.result || j.error || "claude reported an error" };
          const output = typeof j.result === "string" ? j.result : JSON.stringify(j.result);
          return { status: "ok", output, meta: { session_id: j.session_id } };
        } catch {
          // Non-JSON (e.g. --output-format text) → use raw stdout.
          return { status: "ok", output: stdout.trim() };
        }
      },
    };
  }

  if (cfg.type === "codex") {
    return {
      name: "codex",
      async handle(task) {
        const prompt = buildPrompt(task);
        // Codex writes only the FINAL message to --output-last-message; its stdout
        // is a noisy event log. Read the file for a clean answer.
        const outFile = path.join(
          os.tmpdir(),
          `nuanu-codex-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`
        );
        const args = [...cfg.codexArgs, "--output-last-message", outFile, "-"];
        const env = { ...process.env };
        if (task.agent_key) env.NUANU_AGENT_KEY = task.agent_key;
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

  // Generic escape hatch: prompt on stdin, answer on stdout.
  return {
    name: "command",
    async handle(task) {
      if (!cfg.command) return { status: "error", error: "NUANU_ADAPTER_CMD not set for the command adapter" };
      const prompt = buildPrompt(task);
      const env = { ...process.env };
      if (task.agent_key) env.NUANU_AGENT_KEY = task.agent_key;
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
