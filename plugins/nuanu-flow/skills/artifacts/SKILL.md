---
name: artifacts
description: Store, version, search, link, and deliver files and documents in Nuanu Flow — research outputs, reports, datasets; temp scratch vs committed storage, entity binding, downloads, and exact-version Process review.
---

# Artifacts

The artifact registry is the platform's versioned file store (MinIO-backed).
Every meaningful file an agent produces — research, reports, specs, datasets —
belongs here, bound to the entities it's about.

Call pure reads via `execute_read_tool("<name>", {...})` and mutations via
`execute_tool("<name>", {...})`.

A canonical operation name in this skill is guidance, not a current descriptor.
Summary candidates are not cacheable descriptors. Before direct execution, use
a matching cached full descriptor; otherwise make one `search_tools` lookup and
refine by canonical name or request `detail: "full"` to obtain the schema and
`schemaDigest`.

## The model

- **Statuses**: `draft` (registered, bytes pending) → `temp` (scratch,
  TTL-swept unless committed) → `stored` (permanent) → `archived`.
- **Scopes**: `private | project | workspace | run | kb`.
- **Folders**: logical paths like `/projects/<id>/…` — derived automatically
  from context, overridable.
- **Context** drives placement: pass `context: {kind, …}` on create —
  `kind:"run"` (+`run_id`), `"project"` (+`project_id`), `"agent"`
  (+`agent_id`, lands as temp scratch), `"kb"` (+`topic`), `"personal"`
  (+`user_id`). The server derives folder, scope, and typed entity links.
- **Entity links**: artifacts bind to `project | process_run | process_task |
work_item | module | objective | user | team | agent | …` with a relation
  `about | source | output | attachment`.

## Discipline (the failure modes to avoid)

1. **Search before you create.** `search_artifacts` by `q` (keywords over
   name/tags/parsed text), `entity_type`+`entity_id`, `folder`, `tag`, …
   Duplicating an existing artifact instead of versioning it fragments the
   registry.
2. **New content for the same artifact = a new version**, not a new artifact:
   `add_artifact_version` (`content`, optional `change_summary` — treat it
   like a commit message).
3. **Scratch work must be `temp`** (`temp: true` or `context.kind:"agent"`) —
   and **promoted with `commit_artifact` if it turns out to matter**,
   otherwise the TTL sweeper deletes it. A run-scoped artifact commits to
   `project` scope by default (run outputs belong to the project library).

## Workflows

**Create with content (the normal path)** — one call registers the artifact
AND uploads v1:

```js
execute_tool("create_artifact", {
  name: "competitor-research.md", // extension drives MIME inference
  content: "…markdown/text/JSON…",
  tags: ["research", "competitors"],
  context: { kind: "run", run_id: "…" },
});
```

Text, markdown, JSON, CSV, HTML all work inline. Omitting `content` just
registers the row and returns presigned `upload_data` for a raw-bytes REST
upload (binary files) — prefer inline `content` whenever the payload is text.

Inside a Process Agent Task, a declared Artifact output must also include its
exact `output_path` from the task instructions, together with the declared
`kind` and `role:"output"`—for example `output_path:"item.artifacts.image"`.
Do not shorten the path to `image` or rename the field.

**Read**: `get_artifact` (metadata + versions + links + history) →
`get_artifact_download_url` (optionally a specific `version`) → fetch the
short-lived URL for the bytes.

**Bind**: `link_artifact` with `entity_type`, `entity_id`, `relation`
(idempotent). Use `output` for things a run/task produced, `source` for
inputs, `about` for subject matter, `attachment` for misc.

**Promote**: `commit_artifact` (optional explicit `folder`/`scope`) — drops
the TTL and files it permanently.

## Specs

A Spec is an optional, versioned Markdown Artifact (`kind:"spec"`,
`type:"text/markdown"`) attached with `relation:"about"`. Use the semantic
tools when the user wants a Spec on a Flow item/Epic, Module, or
Objective/Initiative:

- `list_specs(entity_type, entity_id)` — zero, one, or several is valid;
- `create_spec(entity_type, entity_id, content, name?)` — creates, uploads,
  and attaches the Markdown Artifact;
- `update_spec(artifact_id, content, change_summary?)` — adds a new immutable
  Artifact version.

`epic` is an alias for `work_item`; `initiative` is an alias for `objective`.
A Spec does not imply that an implementation plan is required. Do not create
or require one unless the user or an explicit Process asks for it.

## Process review and file delivery

If the user asks to **show, send, or attach an artifact as a file** in a
Process Decision or its Telegram delivery, load `bpmn-processes`; this is
Process authoring, not a plain registry lookup.

The Decision must embed the exact named Artifact from its immediate InputSet,
for example `{{input.generate_image.artifacts.hero_image}}`, keep
`deliver_artifacts:true`, and include
`delivery_channels:["in_app","telegram"]` when Telegram is requested. Nuanu
Flow then freezes the exact Artifact version for the Decision viewer and sends
that same byte-backed file through Telegram. Do not replace the input path with the
artifact's source text, filename, an “available in the run” notice, manual
download instructions, or a made-up permanent URL. Do not add a notification
node solely to deliver a Decision artifact.

## Tools Used

`list_specs`, `create_spec`, `update_spec`, `search_artifacts`, `get_artifact`, `create_artifact`, `add_artifact_version`, `link_artifact`, `commit_artifact`, `get_artifact_download_url`
