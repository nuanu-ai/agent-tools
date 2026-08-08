import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_OUTPUT = 8000;
const SUPERVISOR_GIT_CONFIG = ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "http.proxy="];
const UNSAFE_CONFIG_PATTERN =
  "^(url\\..*\\.insteadof|credential\\..*|http(\\..*)?\\.(proxy|extraheader)|remote\\..*\\.proxy|core\\.(askpass|hookspath)|include(if)?\\..*)$";
const GENERATED_OUTPUT_PATHS = [
  ":(glob)**/node_modules/**",
  ":(glob)**/playwright-report/**",
  ":(glob)**/test-results/**",
];

function run(command, args, { cwd, env = process.env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout: stdout.slice(-MAX_OUTPUT), stderr: stderr.slice(-MAX_OUTPUT) };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} exited ${code}: ${result.stderr || result.stdout}`));
    });
  });
}

function safeSegment(value) {
  const segment = String(value || "").replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!segment || segment === "." || segment === "..") throw new Error("Invalid repository cache key");
  return segment;
}

function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Repository worktree path escaped its configured root");
  }
}

async function withGitCredential(credential, callback) {
  const helperDir = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-git-askpass-"));
  const helperPath = path.join(helperDir, "askpass.sh");
  const isolatedConfigPath = path.join(helperDir, "gitconfig");
  await fs.writeFile(isolatedConfigPath, "", { mode: 0o600 });
  await fs.writeFile(
    helperPath,
    '#!/bin/sh\ncase "$1" in *Username*) printf \'%s\' "$NUANU_GIT_USERNAME" ;; *) printf \'%s\' "$NUANU_GIT_PASSWORD" ;; esac\n',
    { mode: 0o700 }
  );
  try {
    return await callback({
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: helperPath,
      GIT_CONFIG_GLOBAL: isolatedConfigPath,
      GIT_CONFIG_NOSYSTEM: "1",
      NUANU_GIT_USERNAME: credential.username,
      NUANU_GIT_PASSWORD: credential.password,
    });
  } finally {
    await fs.rm(helperDir, { recursive: true, force: true });
  }
}

function changedPaths(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function validatePaths(paths) {
  const forbidden = paths.find((name) => name === ".github/workflows" || name.startsWith(".github/workflows/"));
  if (forbidden) throw new Error(`Repository policy forbids workflow changes: ${forbidden}`);
}

async function diffTouches(cwd, range, paths, { diffFilter = "" } = {}) {
  const args = ["diff", "--quiet"];
  if (diffFilter) args.push(`--diff-filter=${diffFilter}`);
  args.push(range, "--", ...paths);
  const result = await run("git", args, { cwd, allowFailure: true });
  if (result.code > 1) {
    throw new Error(`Unable to validate repository changes: ${result.stderr || result.stdout}`);
  }
  return result.code === 1;
}

async function assertRepositoryChangePolicy(cwd, range, { includeUntracked = false } = {}) {
  if (await diffTouches(cwd, range, [".github/workflows"])) {
    throw new Error("Repository policy forbids workflow changes");
  }
  if (await diffTouches(cwd, range, GENERATED_OUTPUT_PATHS, { diffFilter: "ACMRT" })) {
    throw new Error(
      "Repository policy rejects generated dependency or test-output files; keep node_modules, Playwright reports, and test results untracked"
    );
  }
  if (!includeUntracked) return;
  const untrackedGenerated = await run(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...GENERATED_OUTPUT_PATHS],
    { cwd }
  );
  if (untrackedGenerated.stdout.trim()) {
    throw new Error(
      "Repository policy rejects generated dependency or test-output files; add appropriate repository ignore rules"
    );
  }
}

async function assertSafeGitConfiguration(cwd) {
  for (const scope of ["--local", "--worktree"]) {
    const result = await run("git", ["config", scope, "--name-only", "--get-regexp", UNSAFE_CONFIG_PATTERN], {
      cwd,
      allowFailure: true,
    });
    if (result.code === 0 && result.stdout.trim()) {
      throw new Error(`Repository policy rejects unsafe Git configuration: ${result.stdout.trim()}`);
    }
  }
}

export class RepositoryManager {
  constructor({ client, workerId, cacheDir, worktreeDir }) {
    this.client = client;
    this.workerId = workerId;
    this.cacheDir = cacheDir;
    this.worktreeDir = worktreeDir;
    this.tasks = new Map();
    this.repositoryLocks = new Map();
    this.compromisedRepositories = new Set();
  }

  async withRepositoryLock(key, callback) {
    const previous = this.repositoryLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    this.repositoryLocks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.repositoryLocks.get(key) === current) this.repositoryLocks.delete(key);
    }
  }

  async credential(task) {
    return this.client.repositoryCredential(task.task_id, {
      workerId: this.workerId,
      leaseToken: task.lease_token,
    });
  }

  async prepare(task) {
    const descriptor = task.repository;
    if (!descriptor) return null;
    if (descriptor.agent_access_mode !== "read_write_task_branch") {
      throw new Error("Unsupported repository access mode");
    }
    const branchName = String(descriptor.branch_name || "");
    if (!branchName.startsWith("agent/") || branchName === descriptor.default_branch) {
      throw new Error("Repository task branch is outside the allowed agent namespace");
    }

    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.worktreeDir, { recursive: true, mode: 0o700 });
    const repositoryDir = path.join(this.cacheDir, safeSegment(descriptor.project_repository_id));
    const worktreePath = path.join(this.worktreeDir, safeSegment(task.task_id));
    assertInside(this.cacheDir, repositoryDir);
    assertInside(this.worktreeDir, worktreePath);

    return this.withRepositoryLock(repositoryDir, () =>
      this.prepareLocked(task, descriptor, repositoryDir, worktreePath, branchName)
    );
  }

  async prepareLocked(task, descriptor, repositoryDir, worktreePath, branchName) {
    let cacheExists = true;
    try {
      await fs.access(path.join(repositoryDir, ".git"));
    } catch {
      cacheExists = false;
    }
    if (cacheExists) {
      try {
        await assertSafeGitConfiguration(repositoryDir);
      } catch (error) {
        this.compromisedRepositories.add(repositoryDir);
        const cacheInUse = [...this.tasks.values()].some((state) => state.repositoryDir === repositoryDir);
        if (cacheInUse) throw error;
        await fs.rm(repositoryDir, { recursive: true, force: true });
        this.compromisedRepositories.delete(repositoryDir);
        cacheExists = false;
      }
    }

    const cacheReused = cacheExists;
    const credential = await this.credential(task);
    if (!cacheExists) {
      await fs.rm(repositoryDir, { recursive: true, force: true });
      await withGitCredential(credential, (env) =>
        run(
          "git",
          [
            ...SUPERVISOR_GIT_CONFIG,
            "clone",
            "--no-checkout",
            "--origin",
            "origin",
            credential.clone_url,
            repositoryDir,
          ],
          { env }
        )
      );
    }

    await run("git", ["remote", "set-url", "origin", credential.clone_url], { cwd: repositoryDir });
    await withGitCredential(credential, (env) =>
      run(
        "git",
        [...SUPERVISOR_GIT_CONFIG, "fetch", "--prune", credential.clone_url, "+refs/heads/*:refs/remotes/origin/*"],
        {
          cwd: repositoryDir,
          env,
        }
      )
    );

    await run("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repositoryDir,
      allowFailure: true,
    });
    await fs.rm(worktreePath, { recursive: true, force: true });
    await run("git", ["worktree", "prune"], { cwd: repositoryDir });

    const remoteBranch = `refs/remotes/origin/${branchName}`;
    const branchExists =
      (
        await run("git", ["show-ref", "--verify", "--quiet", remoteBranch], {
          cwd: repositoryDir,
          allowFailure: true,
        })
      ).code === 0;
    const baseRef = branchExists ? `origin/${branchName}` : `origin/${credential.default_branch}`;
    const startSha = (await run("git", ["rev-parse", baseRef], { cwd: repositoryDir })).stdout.trim();
    const baseSha = (
      await run("git", ["rev-parse", `origin/${credential.default_branch}`], { cwd: repositoryDir })
    ).stdout.trim();
    await run("git", ["worktree", "add", "-B", branchName, worktreePath, baseRef], { cwd: repositoryDir });

    const state = { repositoryDir, worktreePath, branchName, startSha, baseSha, cacheReused };
    this.tasks.set(task.task_id, state);
    task._worktree_path = worktreePath;
    return state;
  }

  async finalize(task) {
    const state = this.tasks.get(task.task_id);
    if (!state) return null;
    return this.withRepositoryLock(state.repositoryDir, () => this.finalizeLocked(task, state));
  }

  async verifyReadOnly(task) {
    const state = this.tasks.get(task.task_id);
    if (!state) return null;
    return this.withRepositoryLock(state.repositoryDir, async () => {
      const status = (await run("git", ["status", "--porcelain"], { cwd: state.worktreePath })).stdout.trim();
      const headSha = (await run("git", ["rev-parse", "HEAD"], { cwd: state.worktreePath })).stdout.trim();
      if (status || headSha !== state.startSha) {
        const error = new Error("Read-only repository stage modified the canonical task branch");
        error.code = "permission_denied";
        throw error;
      }
      return { branch_name: state.branchName, base_sha: state.baseSha, head_sha: headSha };
    });
  }

  async finalizeLocked(task, state) {
    const { worktreePath, branchName, startSha, baseSha } = state;
    const status = (await run("git", ["status", "--porcelain"], { cwd: worktreePath })).stdout;
    if (status.trim()) {
      await assertRepositoryChangePolicy(worktreePath, "HEAD", { includeUntracked: true });
      const tracked = (await run("git", ["diff", "--name-only", "HEAD"], { cwd: worktreePath })).stdout;
      const untracked = (await run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath }))
        .stdout;
      validatePaths([...changedPaths(tracked), ...changedPaths(untracked)]);
      await run("git", ["add", "-A"], { cwd: worktreePath });
      const label = String(task.step_name || task.step_id || "remote agent changes")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 120);
      await run(
        "git",
        ["-c", "user.name=Nuanu Flow Agent", "-c", "user.email=agents@nuanu.com", "commit", "-m", `chore: ${label}`],
        { cwd: worktreePath }
      );
    }

    const ancestry = await run("git", ["merge-base", "--is-ancestor", startSha, "HEAD"], {
      cwd: worktreePath,
      allowFailure: true,
    });
    if (ancestry.code !== 0) throw new Error("Repository task rewrote history outside its leased branch");
    const diffPaths = (await run("git", ["diff", "--name-only", `${startSha}..HEAD`], { cwd: worktreePath })).stdout;
    await assertRepositoryChangePolicy(worktreePath, `${startSha}..HEAD`);
    validatePaths(changedPaths(diffPaths));

    try {
      await assertSafeGitConfiguration(worktreePath);
    } catch (error) {
      this.compromisedRepositories.add(state.repositoryDir);
      throw error;
    }
    const credential = await this.credential(task);
    await run("git", ["remote", "set-url", "origin", credential.clone_url], { cwd: worktreePath });
    await withGitCredential(credential, (env) =>
      run(
        "git",
        [...SUPERVISOR_GIT_CONFIG, "push", "--no-verify", credential.clone_url, `HEAD:refs/heads/${branchName}`],
        { cwd: worktreePath, env }
      )
    );
    const headSha = (await run("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
    return { branch_name: branchName, base_sha: baseSha, head_sha: headSha, cache_reused: state.cacheReused };
  }

  async cleanup(task) {
    const state = this.tasks.get(task.task_id);
    if (!state) return;
    await this.withRepositoryLock(state.repositoryDir, async () => {
      this.tasks.delete(task.task_id);
      await run("git", ["worktree", "remove", "--force", state.worktreePath], {
        cwd: state.repositoryDir,
        allowFailure: true,
      });
      await fs.rm(state.worktreePath, { recursive: true, force: true });
      await run("git", ["worktree", "prune"], { cwd: state.repositoryDir, allowFailure: true });
      const cacheInUse = [...this.tasks.values()].some((other) => other.repositoryDir === state.repositoryDir);
      if (!cacheInUse && this.compromisedRepositories.delete(state.repositoryDir)) {
        await fs.rm(state.repositoryDir, { recursive: true, force: true });
      }
    });
  }
}
