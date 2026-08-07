#!/usr/bin/env node
// Zero-dependency terminal renderer for Nuanu Flow (Node >= 20, built-in fetch).
//
// Usage:
//   node render.mjs run   <runId>     [--workspace <slug>]
//   node render.mjs watch <runId>     [--workspace <slug>] [--interval 3] [--timeout 600] [--until <status>]
//   node render.mjs board <projectId> [--workspace <slug>] [--limit 8]
//
// Env:
//   NUANU_URL or NUANU_API_URL — Django API base INCLUDING /api (e.g. https://flow.nuanu.com/api)
//   NUANU_TOKEN                — personal API token (nuanu_api_…)
//   NUANU_WORKSPACE            — default workspace slug (overridden by --workspace)
//
// Output is plain append-only stdout (no alt-screen), safe to embed in an
// agent reply. Respects NO_COLOR / non-TTY by emitting no ANSI codes.

const API = (process.env.NUANU_API_URL || process.env.NUANU_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.NUANU_TOKEN || "";
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const color = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => color(32, s);
const red = (s) => color(31, s);
const yellow = (s) => color(33, s);
const dim = (s) => color(2, s);
const bold = (s) => color(1, s);

function fail(msg) {
  console.error(`render: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    else args._.push(a);
  }
  return args;
}

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: { "X-Api-Key": TOKEN } });
  if (!res.ok) fail(`GET ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

// Django list endpoints answer with a raw array, a {results: []} page, or a
// grouped {results: {group: []}} — normalize all three.
function unwrapList(data) {
  if (Array.isArray(data)) return data;
  const results = data?.results;
  if (Array.isArray(results)) return results;
  if (results && typeof results === "object") return Object.values(results).flat();
  return [];
}

const fmtDuration = (ms) => {
  if (ms < 0 || Number.isNaN(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

const short = (id) => (id || "").slice(0, 8);
const now = () => new Date().toTimeString().slice(0, 8);

// ---------------------------------------------------------------- run views

const DONE = new Set(["done", "completed", "success", "succeeded"]);
const FAILED = new Set(["failed", "error"]);
const ACTIVE = new Set(["waiting", "running", "in_progress", "started", "pending_decision"]);

function latestLogPerStep(stepLogs) {
  const byStep = new Map();
  for (const log of stepLogs) byStep.set(log.step_id, log); // logs are ordered by entered_at
  return byStep;
}

function stepGlyph(nodeId, run, logs) {
  const log = logs.get(nodeId);
  if (log) {
    const status = String(log.status || "").toLowerCase();
    if (FAILED.has(status)) return red("✗");
    if (DONE.has(status)) return green("✓");
    if (ACTIVE.has(status) || !log.completed_at) return yellow("▶");
    return green("✓");
  }
  if (run.current_step_id === nodeId) return yellow("▶");
  return dim("○");
}

const TYPE_LABEL = {
  human_task: "human",
  agent_task: "agent",
  decision: "decision",
  gateway: "gateway",
  notification: "notify",
  webhook: "webhook",
};

function nodeLine(node, run, logs) {
  const glyph = stepGlyph(node.id, run, logs);
  const name = node.name || node.config?.name || node.id;
  const kind = TYPE_LABEL[node.type] ? dim(` (${TYPE_LABEL[node.type]})`) : "";
  const log = logs.get(node.id);
  let extra = "";
  if (log?.entered_at) {
    const end = log.completed_at ? new Date(log.completed_at) : new Date();
    const dur = fmtDuration(end - new Date(log.entered_at));
    extra = log.completed_at ? dim(`  ${dur}`) : yellow(`  ⏳ ${dur}`);
  }
  if (String(log?.status || "").toLowerCase() === "failed" && log?.error_message)
    extra += red(`  ${log.error_message}`);
  return `${glyph} ${node.type === "start" || node.type === "end" ? dim(name) : name}${kind}${extra}`;
}

function edgeLabel(when) {
  if (!when) return "";
  if (when.outcome) return `[${when.outcome}]`;
  if (when.branch) return `[${when.branch}]`;
  if (when.otherwise) return "[otherwise]";
  if (when.var) return `[${when.var} ${when.op} ${when.value}]`;
  return "";
}

// Append-only tree rendering of the graph: chains stay in one column, branch
// points fan out with ├─/└─ connectors, joins/loops print a reference instead
// of re-walking (also terminates cycles like refine loops).
function renderRunDiagram(graph, run, stepLogs) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = (id) => graph.edges.filter((e) => e.from === id);
  const logs = latestLogPerStep(stepLogs);
  const visited = new Set();
  const lines = [];
  const nameOf = (id) => nodes.get(id)?.name || id;

  function walkChain(id, prefix, headPrefix) {
    let cur = id;
    let curPrefix = headPrefix;
    for (;;) {
      const node = nodes.get(cur);
      if (!node) return;
      lines.push(curPrefix + nodeLine(node, run, logs));
      visited.add(cur);
      curPrefix = prefix;
      const outs = outEdges(cur);
      if (outs.length === 0) return;
      if (outs.length === 1) {
        const edge = outs[0];
        const label = edgeLabel(edge.when);
        if (visited.has(edge.to)) {
          lines.push(prefix + dim(`└${label ? `─${label}` : ""}→ ↺ ${nameOf(edge.to)}`));
          return;
        }
        lines.push(prefix + dim(label ? `│ ${label}` : "│"));
        cur = edge.to;
        continue;
      }
      outs.forEach((edge, i) => {
        const isLast = i === outs.length - 1;
        const connector = isLast ? "└─" : "├─";
        const label = edgeLabel(edge.when);
        const head = prefix + dim(`${connector}${label}→ `);
        if (visited.has(edge.to)) {
          lines.push(head + dim(`↺ ${nameOf(edge.to)}`));
        } else {
          walkChain(edge.to, prefix + (isLast ? "   " : dim("│") + "  "), head);
        }
      });
      return;
    }
  }

  const start = graph.nodes.find((n) => n.type === "start") || graph.nodes[0];
  if (start) walkChain(start.id, "", "");
  // Orphan/unreached-by-DFS nodes (defensive; valid graphs shouldn't have them)
  for (const node of graph.nodes) {
    if (!visited.has(node.id)) lines.push(dim("· ") + nodeLine(node, run, logs));
  }
  return lines.join("\n");
}

function runHeader(run) {
  const statusColor = run.status === "completed" ? green : FAILED.has(run.status) ? red : yellow;
  const started = run.started_at ? new Date(run.started_at) : null;
  const ended = run.completed_at || run.failed_at;
  const elapsed = started ? fmtDuration((ended ? new Date(ended) : new Date()) - started) : "";
  const parts = [
    bold(run.template_name || "process"),
    `run ${short(run.id)}`,
    statusColor(run.status.toUpperCase()),
    elapsed && `${ended ? "took" : "elapsed"} ${elapsed}`,
    run.current_step_name && !ended && `at: ${run.current_step_name}`,
  ];
  return parts.filter(Boolean).join(dim(" · "));
}

async function fetchRunBundle(ws, runId) {
  const run = await api(`/workspaces/${ws}/process-runs/${runId}/`);
  const [stepLogs, template] = await Promise.all([
    api(`/workspaces/${ws}/process-runs/${runId}/steps/`).then(unwrapList),
    api(`/workspaces/${ws}/process-templates/${run.template_id}/`),
  ]);
  return { run, stepLogs, graph: template.graph || { nodes: [], edges: [] } };
}

async function cmdRun(ws, runId) {
  const { run, stepLogs, graph } = await fetchRunBundle(ws, runId);
  console.log(runHeader(run));
  console.log("");
  console.log(renderRunDiagram(graph, run, stepLogs));
  if (run.error_message) console.log(`\n${red("error:")} ${run.error_message}`);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

async function cmdWatch(ws, runId, opts) {
  const interval = Math.max(1, Number(opts.interval || 3)) * 1000;
  const timeout = Math.max(5, Number(opts.timeout || 600)) * 1000;
  const until = opts.until === "done" ? TERMINAL_STATUSES : opts.until ? new Set([opts.until]) : TERMINAL_STATUSES;
  const deadline = Date.now() + timeout;

  let prev = null;
  let prevSteps = new Map();
  for (;;) {
    const { run, stepLogs, graph } = await fetchRunBundle(ws, runId);
    const logs = latestLogPerStep(stepLogs);
    if (!prev) {
      console.log(runHeader(run));
      console.log("");
      console.log(renderRunDiagram(graph, run, stepLogs));
      console.log(dim(`\n— watching (interval ${interval / 1000}s, timeout ${timeout / 1000}s) —`));
    } else {
      for (const [stepId, log] of logs) {
        const before = prevSteps.get(stepId);
        if (!before) console.log(`${dim(now())} ${yellow("▶")} entered ${log.step_name || stepId}${TYPE_LABEL[log.step_type] ? dim(` (${TYPE_LABEL[log.step_type]})`) : ""}`);
        else if (before.status !== log.status || (!before.completed_at && log.completed_at)) {
          const glyph = FAILED.has(String(log.status).toLowerCase()) ? red("✗") : log.completed_at ? green("✓") : yellow("▶");
          console.log(`${dim(now())} ${glyph} ${log.step_name || stepId} → ${log.status}`);
        }
      }
      if (prev.status !== run.status)
        console.log(`${dim(now())} ${bold("run")} → ${run.status}${run.error_message ? red(` (${run.error_message})`) : ""}`);
    }
    prev = run;
    prevSteps = logs;

    if (until.has(run.status)) {
      console.log("");
      console.log(runHeader(run));
      process.exit(run.status === "completed" ? 0 : 1);
    }
    if (Date.now() > deadline) {
      console.log(dim(`\n— watch timeout after ${timeout / 1000}s; run is ${run.status} —`));
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// -------------------------------------------------------------- board view

const PRIORITY_GLYPH = { urgent: "‼", high: "▲", medium: "●", low: "▽", none: "·" };
const GROUP_ORDER = ["backlog", "unstarted", "started", "completed", "cancelled"];
const COL_WIDTH = 28;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));

async function cmdBoard(ws, projectId, opts) {
  const limit = Math.max(1, Number(opts.limit || 8));
  const [project, states, issues] = await Promise.all([
    api(`/workspaces/${ws}/projects/${projectId}/`),
    api(`/workspaces/${ws}/projects/${projectId}/states/`).then(unwrapList),
    api(`/workspaces/${ws}/projects/${projectId}/issues/?per_page=100`).then(unwrapList),
  ]);

  states.sort(
    (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (a.sequence || 0) - (b.sequence || 0)
  );
  const byState = new Map(states.map((s) => [s.id, []]));
  for (const issue of issues) {
    const bucket = byState.get(issue.state_id ?? issue.state);
    if (bucket) bucket.push(issue);
  }

  console.log(bold(`${project.name || projectId} — board`) + dim(` (${issues.length} items)`));
  console.log("");

  const columns = states.map((state) => {
    const items = byState.get(state.id) || [];
    const rows = items
      .slice(0, limit)
      .map((i) => clip(`${PRIORITY_GLYPH[i.priority ?? "none"] || "·"} ${project.identifier ? `${project.identifier}-${i.sequence_id} ` : ""}${i.name}`, COL_WIDTH - 2));
    if (items.length > limit) rows.push(dim(`+${items.length - limit} more`));
    return { header: clip(`${state.name} (${items.length})`, COL_WIDTH - 2), rows };
  });

  const height = Math.max(...columns.map((c) => c.rows.length), 0);
  const line = (cells) => cells.map((c) => pad(c, COL_WIDTH)).join("");
  console.log(line(columns.map((c) => bold(c.header))));
  console.log(line(columns.map((c) => "─".repeat(Math.min(c.header.length, COL_WIDTH - 2)))));
  for (let r = 0; r < height; r++) console.log(line(columns.map((c) => c.rows[r] || "")));
}

// ------------------------------------------------------------------- demo

// Renders a built-in sample run — offline preview + smoke test (no API/env).
function cmdDemo() {
  const graph = {
    nodes: [
      { id: "start", type: "start", name: "start" },
      { id: "quote", type: "agent_task", name: "Draft quote" },
      { id: "approve", type: "decision", name: "Approve quote?" },
      { id: "gate", type: "gateway", name: "route" },
      { id: "fulfil", type: "agent_task", name: "Fulfil order" },
      { id: "notify", type: "notification", name: "Notify requester" },
      { id: "end_ok", type: "end", name: "end" },
      { id: "end_no", type: "end", name: "end (rejected)" },
    ],
    edges: [
      { from: "start", to: "quote" },
      { from: "quote", to: "approve" },
      { from: "approve", to: "gate" },
      { from: "gate", to: "fulfil", when: { outcome: "approve" } },
      { from: "gate", to: "quote", when: { outcome: "refine" } },
      { from: "gate", to: "end_no", when: { otherwise: true } },
      { from: "fulfil", to: "notify" },
      { from: "notify", to: "end_ok" },
    ],
  };
  const run = {
    id: "demo1234-0000",
    template_name: "Purchase Approval",
    status: "waiting",
    current_step_id: "approve",
    current_step_name: "Approve quote?",
    started_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  };
  const stepLogs = [
    { step_id: "start", step_name: "start", step_type: "start", status: "done",
      entered_at: run.started_at, completed_at: run.started_at },
    { step_id: "quote", step_name: "Draft quote", step_type: "agent_task", status: "done",
      entered_at: run.started_at, completed_at: new Date(Date.now() - 10 * 60_000).toISOString() },
    { step_id: "approve", step_name: "Approve quote?", step_type: "decision", status: "waiting",
      entered_at: new Date(Date.now() - 10 * 60_000).toISOString(), completed_at: null },
  ];
  console.log(runHeader(run));
  console.log("");
  console.log(renderRunDiagram(graph, run, stepLogs));
}

// -------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const [verb, target] = args._;

if (verb === "demo") {
  cmdDemo();
  process.exit(0);
}

const ws = args.workspace || process.env.NUANU_WORKSPACE;

if (!API) fail("set NUANU_URL (or NUANU_API_URL) to the API base including /api");
if (!TOKEN) fail("set NUANU_TOKEN to a personal API token (nuanu_api_…)");
if (!verb || !target) fail("usage: render.mjs run|watch <runId> | board <projectId> [--workspace <slug>] | demo");
if (!ws) fail("pass --workspace <slug> or set NUANU_WORKSPACE");

if (verb === "run") await cmdRun(ws, target);
else if (verb === "watch") await cmdWatch(ws, target, args);
else if (verb === "board") await cmdBoard(ws, target, args);
else fail(`unknown verb "${verb}" (expected run, watch, board, or demo)`);
