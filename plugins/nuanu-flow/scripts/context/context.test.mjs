import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";

import { bind, cacheSnapshot, connectionAt, contextPointer, scopeKey } from "./context.mjs";
import { resolveRepositoryContext } from "../../hooks/repository-context.mjs";

let temporary;
let repository;

const connection = {
  environment: "local",
  mcp_url: "http://localhost:3001/mcp",
};

const project = {
  id: "project_1",
  identifier: "FLOW",
  name: "Flow",
  flow: {
    revision: 7,
    name: "Agentic development",
    description: "Use the saved project guidance and gates.",
    mode: "advisory",
    columns: [
      {
        id: "backlog",
        state_id: "state_1",
        name: "Backlog",
        description: "Clarify the requested outcome.",
        owner: "shared",
        group: "backlog",
        sequence: 1000,
        default: true,
        next: ["doing"],
        requires: [],
      },
      {
        id: "doing",
        state_id: "state_2",
        name: "Doing",
        description: "Implement using the current project context.",
        owner: "agent",
        group: "started",
        sequence: 2000,
        default: false,
        next: [],
        requires: ["plan"],
      },
    ],
  },
};

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nuanu-context-"));
  repository = path.join(temporary, "repo");
  await fs.mkdir(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
});

afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

test("connection registration rejects production fallback in a local bundle", async () => {
  const root = path.join(temporary, "plugin");
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "connection.json"),
    JSON.stringify({ environment: "local", mcp_url: "https://flow.nuanu.com/mcp-server/mcp" })
  );
  await assert.rejects(connectionAt(root), /Invalid registered connection/);
});

test("bindings are selected by registered environment and local invalid data blocks fallback", async () => {
  await fs.writeFile(
    path.join(repository, ".nuanu-flow.json"),
    JSON.stringify({
      version: 2,
      environments: {
        production: { workspace_slug: "prod", project_identifier: "PROD" },
        local: { workspace_slug: "shared-local", project_identifier: "LOCAL" },
      },
    })
  );
  await fs.writeFile(
    path.join(repository, ".nuanu-flow.local.json"),
    JSON.stringify({
      version: 2,
      environments: { local: { workspace_slug: "dev", project_identifier: "DEV" } },
    })
  );

  assert.equal((await resolveRepositoryContext(repository, "local")).projectIdentifier, "DEV");
  assert.equal((await resolveRepositoryContext(repository, "production")).projectIdentifier, "PROD");

  await fs.writeFile(path.join(repository, ".nuanu-flow.local.json"), "{broken");
  assert.equal(await resolveRepositoryContext(repository, "local"), null);
});

test("snapshot is principal scoped, contains no supplied secrets, and needs a matching session", async () => {
  await bind({
    cwd: repository,
    connection,
    binding: { workspace_slug: "dev", project_identifier: "FLOW" },
  });
  const result = await cacheSnapshot({
    cwd: repository,
    connection,
    principal: "person_1",
    workspace: "dev",
    project,
    directory: { complete: true, projects: [{ id: "project_1", identifier: "FLOW", name: "Flow" }] },
    session: "session_1",
    active_item: "issue_1",
    artifacts: [{ artifact_id: "artifact_1", version_id: "version_1", path: "plans/plan.md" }],
    effective_mode: "balanced",
    token: "must-not-be-written",
  });

  const pointer = await contextPointer({
    cwd: repository,
    connection,
    principal: "person_1",
    session: "session_1",
  });
  assert.match(pointer, /project FLOW/);
  assert.match(pointer, /Flow revision 7/);
  assert.match(pointer, /refresh get_project/);
  assert.doesNotMatch(pointer, /must-not-be-written/);
  assert.match(result.key, /^[a-f0-9]{64}$/);

  const otherPrincipal = await contextPointer({
    cwd: repository,
    connection,
    principal: "person_2",
    session: "session_1",
  });
  assert.match(otherPrincipal, /No usable scoped snapshot/);
  assert.notEqual(scopeKey(connection, "person_1"), scopeKey(connection, "person_2"));
});

test("snapshot rejects malformed or lossy Flow graphs", async () => {
  const snapshot = (flow) =>
    cacheSnapshot({
      cwd: repository,
      connection,
      principal: "person_1",
      workspace: "dev",
      project: { ...project, flow },
      session: "session_1",
    });

  await assert.rejects(
    snapshot({ ...project.flow, columns: [project.flow.columns[0], { ...project.flow.columns[1], id: "backlog" }] }),
    /Incomplete project Flow/
  );
  await assert.rejects(
    snapshot({ ...project.flow, columns: [{ ...project.flow.columns[0], next: ["missing"] }] }),
    /Incomplete project Flow/
  );
  await assert.rejects(
    snapshot({ ...project.flow, columns: [{ ...project.flow.columns[0], requires: ["password"] }] }),
    /Incomplete project Flow/
  );
});

test("explicit bind keeps generated files local through git info exclude", async () => {
  await bind({
    cwd: repository,
    connection,
    binding: { workspace_slug: "dev", project_identifier: "FLOW" },
  });
  const binding = JSON.parse(await fs.readFile(path.join(repository, ".nuanu-flow.local.json"), "utf8"));
  assert.equal(binding.environments.local.project_identifier, "FLOW");
  const excludes = await fs.readFile(path.join(repository, ".git/info/exclude"), "utf8");
  assert.match(excludes, /^\/\.nuanu-flow\.local\.json$/m);
  assert.match(excludes, /^\/\.nuanu-flow-cache\/$/m);
});
