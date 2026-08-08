# Nuanu Flow Worker

Opt-in execution companion for the `nuanu-flow` plugin. This package enrolls
a remote Agent host, runs the worker daemon, creates isolated task workspaces,
invokes the selected coding harness, and delivers acknowledged results and
Artifacts back to Flow.

A supported native remote-worker installation always includes both plugins:

- `nuanu-flow` provides the single MCP definition, complete Nuanu domain-skill
  set, and general communication-bus adapter;
- `nuanu-flow-worker` provides enrollment, protected credentials, heartbeat,
  task wake/claim/lease execution, diagnostics, and exact-session observation.

The worker must receive the exact general-plugin bus script path as
`NUANU_AGENT_BUS_SCRIPT`. It never guesses a sibling plugin cache path. If the
bus cannot load, task execution remains available and the worker reports
degraded collaboration separately from its authoritative heartbeat state.

Canonical runtime source is `apps/worker/src`. The installed plugin artifact
contains runtime files only; tests stay with `apps/worker`.

Browser QA is an explicit host capability. Set `NUANU_BROWSER_QA=1` only on a
worker with Playwright installed. If Playwright is outside the companion
plugin's module tree, also set `NUANU_QA_PLAYWRIGHT_MODULE` to the exact module
path. The worker resolves this dependency before advertising `browser_qa_v1`
and fails startup with a configuration error when it is unavailable.
