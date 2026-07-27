#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const planeRoot = path.resolve(repositoryRoot, "../plane");
const apiRoot = path.join(planeRoot, "apps", "api");
const fixtureCommand = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "portable-agent-command.mjs",
);
const marker = `portable-live-${Date.now().toString(36)}`;
const apiBase = "http://localhost:8000/api";
const skillsCli = "skills@1.5.20";
const secretPattern = /nuanu_(?:join|flow)_[0-9a-f]{64}/g;

function redact(value) {
  return String(value ?? "").replaceAll(secretPattern, "[redacted]");
}

function djangoShell(code) {
  return execFileSync(
    "/bin/zsh",
    [
      "-c",
      'set -a; source .env; set +a; exec venv/bin/python manage.py shell --settings=plane.settings.local -c "$1"',
      "nuanu-portable-live",
      code,
    ],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        NUANU_PORTABLE_LIVE_MARKER: marker,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
}

function parseLastJson(output) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Django may print an automatic-import notice before the command output.
    }
  }
  throw new Error("Django acceptance helper returned no JSON");
}

function run(program, args, { cwd = repositoryRoot, input, env = {} } = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync(program, args, {
        cwd,
        env: { ...process.env, ...env },
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

async function waitForState(predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  let state;
  while (Date.now() - started < timeoutMs) {
    state = parseLastJson(
      djangoShell(`
import json
import os
from plane.db.models import AgentEmployee, ProcessRun, RemoteAgentTask, Workspace
marker = os.environ["NUANU_PORTABLE_LIVE_MARKER"]
workspace = Workspace.objects.filter(slug=marker, deleted_at__isnull=True).first()
agent = AgentEmployee.objects.filter(workspace=workspace, name="portable-worker", deleted_at__isnull=True).first() if workspace else None
run = ProcessRun.objects.filter(workspace=workspace, deleted_at__isnull=True).first() if workspace else None
task = RemoteAgentTask.objects.filter(workspace=workspace, deleted_at__isnull=True).first() if workspace else None
print(json.dumps({
    "agent_health": agent.health_status if agent else None,
    "run_status": run.status if run else None,
    "run_step": run.current_step_id if run else None,
    "task_status": task.status if task else None,
    "task_result": task.result if task else None,
}))
`),
    );
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out at state ${JSON.stringify(state)}`);
}

async function serviceReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "nuanu-portable-live-"),
);

try {
  assert.equal(
    await serviceReady("http://localhost:8000/api/"),
    true,
    "local Flow API is not reachable",
  );
  assert.equal(
    await serviceReady("http://localhost:4000/"),
    true,
    "local process engine is not reachable",
  );
  await access(path.join(apiRoot, "venv", "bin", "python"));

  const project = path.join(temporaryRoot, "project");
  const home = path.join(temporaryRoot, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  const installed = run(
    "npx",
    [
      "--yes",
      skillsCli,
      "add",
      repositoryRoot,
      "--skill",
      "nuanu-flow",
      "--agent",
      "universal",
      "--copy",
      "-y",
    ],
    {
      cwd: project,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        NO_COLOR: "1",
      },
    },
  );
  assert.equal(installed.code, 0, redact(installed.stderr));
  const skillRoot = path.join(project, ".agents", "skills", "nuanu-flow");
  const worker = path.join(skillRoot, "scripts", "worker.mjs");
  await access(worker);

  const setup = parseLastJson(
    djangoShell(`
import json
import os
from plane.app.services.process_engine import advance_process
from plane.db.models import (
    AgentEmployee,
    AgentEmployeeEnrollment,
    AgentEmployeeWorkspaceMember,
    AgentRuntime,
    ProcessRun,
    ProcessTemplate,
    User,
    Workspace,
    WorkspaceMember,
)
from plane.utils.process_compiler import compile_graph
marker = os.environ["NUANU_PORTABLE_LIVE_MARKER"]
user = User.objects.create(
    email=f"{marker}@example.test",
    username=marker,
    first_name="Portable",
    last_name="Acceptance",
)
workspace = Workspace.objects.create(name=marker, slug=marker, owner=user)
WorkspaceMember.objects.create(workspace=workspace, member=user, role=20)
agent = AgentEmployee.objects.create(
    workspace=workspace,
    name="portable-worker",
    display_name="Portable Worker Acceptance",
    runtime=AgentRuntime.REMOTE,
    system_prompt="Return the exact requested acceptance marker.",
    created_by=user,
    updated_by=user,
)
AgentEmployeeWorkspaceMember.objects.create(
    workspace=workspace,
    agent_employee=agent,
    role=15,
    created_by=user,
    updated_by=user,
)
enrollment = AgentEmployeeEnrollment(
    agent_employee=agent,
    created_by=user,
    updated_by=user,
)
enrollment.save()
graph = {
    "name": marker,
    "nodes": [
        {"id": "start", "type": "start"},
        {
            "id": "portable_agent",
            "type": "agent_task",
            "name": "Portable worker",
            "config": {
                "agent_employee_id": str(agent.id),
                "instruction": "Reply with exactly portable-live-ok",
            },
        },
        {"id": "end", "type": "end"},
    ],
    "edges": [
        {"from": "start", "to": "portable_agent"},
        {"from": "portable_agent", "to": "end"},
    ],
}
xml = compile_graph(graph)
template = ProcessTemplate.objects.create(
    workspace=workspace,
    name=marker,
    description="Portable worker live acceptance",
    bpmn_xml=xml,
    is_active=True,
    created_by=user,
    updated_by=user,
)
run = ProcessRun.objects.create(
    workspace=workspace,
    template=template,
    trigger_source="manual",
    triggered_by=user,
    bpmn_xml_snapshot=xml,
    created_by=user,
    updated_by=user,
)
advance_process(str(run.id), f"/api/runs/{run.id}/execute", {})
print(json.dumps({
    "enrollment_token": enrollment.plaintext_token,
    "agent_id": str(agent.id),
    "run_id": str(run.id),
    "workspace": workspace.slug,
}))
`),
  );
  assert.match(setup.enrollment_token, /^nuanu_join_[0-9a-f]{64}$/);

  const credentialFile = path.join(temporaryRoot, "worker-credential.json");
  const enrolled = run(
    process.execPath,
    [
      worker,
      "enroll",
      "--base-url",
      apiBase,
      "--credential-file",
      credentialFile,
    ],
    { input: `${setup.enrollment_token}\n` },
  );
  setup.enrollment_token = undefined;
  assert.equal(enrolled.code, 0, redact(enrolled.stderr));
  assert.doesNotMatch(`${enrolled.stdout}${enrolled.stderr}`, secretPattern);
  const connected = run(
    process.execPath,
    [
      worker,
      "status",
      "--base-url",
      apiBase,
      "--credential-file",
      credentialFile,
    ],
  );
  assert.equal(connected.code, 0, redact(connected.stderr));
  const connectedState = JSON.parse(connected.stdout);
  assert.equal(connectedState.status, "connected");
  assert.equal(connectedState.agent.id, setup.agent_id);
  assert.equal(connectedState.agent.workspace, setup.workspace);
  assert.equal((await readFile(credentialFile, "utf8")).includes("nuanu_join_"), false);

  await waitForState(
    (state) => state.task_status === "pending",
    "remote task creation",
  );

  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureCommand)}`;
  const workerRun = run(
    process.execPath,
    [
      worker,
      "run",
      "--base-url",
      apiBase,
      "--credential-file",
      credentialFile,
      "--command",
      command,
      "--once",
    ],
  );
  assert.equal(workerRun.code, 0, redact(workerRun.stderr));
  assert.doesNotMatch(`${workerRun.stdout}${workerRun.stderr}`, secretPattern);

  const completed = await waitForState(
    (state) =>
      state.task_status === "done" &&
      state.run_status === "completed",
    "process completion",
  );
  assert.equal(completed.agent_health, "online");
  assert.equal(completed.task_result.output, "portable-live-ok");

  parseLastJson(
    djangoShell(`
import json
import os
from plane.db.models import AgentEmployeeKey, Workspace
marker = os.environ["NUANU_PORTABLE_LIVE_MARKER"]
workspace = Workspace.objects.get(slug=marker, deleted_at__isnull=True)
count = AgentEmployeeKey.objects.filter(
    agent_employee__workspace=workspace,
    is_active=True,
).update(is_active=False)
print(json.dumps({"revoked": count}))
`),
  );
  const revokedStatus = run(
    process.execPath,
    [
      worker,
      "status",
      "--base-url",
      apiBase,
      "--credential-file",
      credentialFile,
    ],
  );
  assert.notEqual(revokedStatus.code, 0);
  assert.doesNotMatch(
    `${revokedStatus.stdout}${revokedStatus.stderr}`,
    secretPattern,
  );

  process.stdout.write(
    "portable worker live acceptance: enrollment, claim, completion, process advancement, and revocation passed\n",
  );
} catch (error) {
  throw new Error(redact(error.stack || error.message));
} finally {
  try {
    djangoShell(`
import json
import os
from plane.db.models import User, Workspace
marker = os.environ["NUANU_PORTABLE_LIVE_MARKER"]
workspace = Workspace.objects.filter(slug=marker).first()
if workspace:
    workspace.delete()
User.objects.filter(username=marker).delete()
print(json.dumps({"cleaned": True}))
`);
  } catch {
    process.stderr.write(
      `Live acceptance cleanup needs review for marker ${marker}\n`,
    );
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
