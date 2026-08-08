import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isInside(parent, candidate, { allowRoot = false } = {}) {
  return (allowRoot && candidate === parent) || candidate.startsWith(parent + path.sep);
}

export class TaskWorkspaceManager {
  constructor({ root = path.join(os.tmpdir(), "nuanu-flow-task-workspaces"), ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.root = path.resolve(root);
    this.ttlMs = Math.max(1, Number(ttlMs) || 24 * 60 * 60 * 1000);
  }

  taskPath(task) {
    const taskId = String(task?.task_id || "");
    if (!UUID.test(taskId)) throw new Error("Task workspace requires a UUID task_id");
    return path.join(this.root, taskId.toLowerCase());
  }

  async prepare(task) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const taskRoot = this.taskPath(task);
    await mkdir(taskRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.join(taskRoot, "tmp"), { recursive: true, mode: 0o700 });
    return taskRoot;
  }

  async _validatedTaskRoot(taskRoot) {
    let rootReal;
    try {
      rootReal = await realpath(this.root);
    } catch {
      throw new Error("Task workspace root does not exist");
    }
    let taskReal;
    try {
      taskReal = await realpath(path.resolve(taskRoot));
    } catch {
      throw new Error("Task workspace does not exist");
    }
    if (!isInside(rootReal, taskReal) || !UUID.test(path.basename(taskReal))) {
      throw new Error("Task workspace must be a UUID task child");
    }
    return taskReal;
  }

  async resolveFile(taskRoot, relativePath) {
    if (typeof relativePath !== "string" || !relativePath.trim() || path.isAbsolute(relativePath)) {
      throw new Error("Artifact path must be relative to the task workspace");
    }
    const rootReal = await this._validatedTaskRoot(taskRoot);
    const rootInput = path.resolve(taskRoot);
    const unresolved = path.resolve(rootInput, relativePath);
    if (!isInside(rootInput, unresolved)) {
      throw new Error("Artifact path resolves outside the task workspace");
    }
    let item;
    try {
      item = await lstat(unresolved);
    } catch {
      throw new Error("Artifact path is not a regular file in the task workspace");
    }
    if (!item.isFile() && !item.isSymbolicLink()) {
      throw new Error("Artifact path is not a regular file in the task workspace");
    }
    let candidate;
    try {
      candidate = await realpath(unresolved);
    } catch {
      throw new Error("Artifact path is not a regular file in the task workspace");
    }
    if (!isInside(rootReal, candidate)) {
      throw new Error("Artifact path resolves outside the task workspace");
    }
    const resolvedStat = await stat(candidate);
    if (!resolvedStat.isFile()) throw new Error("Artifact path is not a regular file in the task workspace");
    return unresolved;
  }

  async removePath(candidatePath) {
    const resolved = path.resolve(candidatePath);
    const rootInput = path.resolve(this.root);
    let rootReal;
    try {
      rootReal = await realpath(this.root);
    } catch {
      rootReal = this.root;
    }
    let candidateReal = resolved;
    let exists = true;
    try {
      candidateReal = await realpath(resolved);
    } catch {
      exists = false;
    }
    const safeParent = exists
      ? candidateReal !== rootReal && isInside(rootReal, candidateReal)
      : resolved !== rootInput && isInside(rootInput, resolved);
    if (!safeParent || !UUID.test(path.basename(candidateReal))) {
      throw new Error("Cleanup target must be a UUID task child");
    }
    await rm(resolved, { recursive: true, force: true });
  }

  async cleanup(task) {
    await this.removePath(this.taskPath(task));
  }

  async collectStale({ now = Date.now(), limit = 100 } = {}) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const removed = [];
    for (const entry of entries) {
      if (removed.length >= Math.max(1, limit)) break;
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const candidate = path.join(this.root, entry.name);
      let item;
      try {
        item = await stat(candidate);
      } catch {
        continue;
      }
      if (now - item.mtimeMs < this.ttlMs) continue;
      await this.removePath(candidate);
      removed.push(entry.name);
    }
    return removed;
  }
}
