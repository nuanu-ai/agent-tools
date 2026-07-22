---
description: Render a Nuanu Flow process run as a terminal diagram (optionally follow it live)
argument-hint: <runId> [watch]
---

Render the process run the user asked about ($ARGUMENTS) as a terminal
diagram using the plugin's zero-dependency renderer.

1. **Preflight**: the renderer needs `NUANU_URL` (or `NUANU_API_URL`) — the
   API base including `/api` — plus `NUANU_TOKEN` and a workspace
   (`NUANU_WORKSPACE` or `--workspace`). If missing, point at
   `/nuanu-flow:setup`.

2. **Snapshot** (default):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/render/render.mjs" run <runId>
   ```
   Show the output verbatim in a fenced code block (it is plain unicode,
   NO_COLOR-safe). Below it, add one summary line (current step, what it's
   waiting on) and the run's web link (from `get_process_run`'s `Web:` line
   if you need it).

3. **Follow** (only when the user said watch/follow):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/render/render.mjs" watch <runId> --until done --timeout 300
   ```
   This prints append-only transition lines and exits when the run reaches a
   terminal state (exit 0 completed / 1 failed·cancelled / 3 timeout — on 3,
   report the run is still going, don't treat it as an error). Never run
   `watch` without `--timeout`.

4. If the run is parked on a **decision**, offer `/nuanu-flow:decisions` to
   resolve it right here.

Tip: `node "${CLAUDE_PLUGIN_ROOT}/scripts/render/render.mjs" demo` renders a
sample run offline — useful to preview the diagram style.
