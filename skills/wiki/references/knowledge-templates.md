# Knowledge templates and saved guidance

Use this reference for setup, template recommendations, structure/guide edits,
or initialization recovery. Everyday page work follows the saved guide in
`get_knowledge_definition`, not a preset's original instructions.

## Resolve, inspect, and recommend

1. Resolve the user's explicit target or current authorized repository/project
   binding. Fetch the actual project with `get_project` when project knowledge
   is intended. Do not fall back to workspace scope if project resolution fails.
   Initialization/definition tools use `target_type` plus the corresponding
   `project_id` or `team_id`; resolve an identifier to its UUID first.
2. Read `get_knowledge_definition` and the relevant Wiki tree. For a populated
   scope, keep or extend its existing definition where appropriate. Do not
   rerun empty-scope initialization or duplicate its folder tree.
3. Inspect the project description, saved Flow guidance, relevant accessible
   work/knowledge, and the user's outcome. Read related entities or sources
   only when useful. Do not classify a project from its name alone.
4. Call `list_memory_initialization_blueprints` for the same target. Its alias
   `list_memory_blueprints` reads the same catalog. Use returned compatibility,
   descriptions, sections, and page formats to recommend an exact ID/version
   with a brief reason and useful adaptations. Explicit user selection wins.
   Where context is insufficient, make the recommendation tentative or ask one
   focused question. A recommendation request creates no pages or entities.
5. Customize the returned definition in conversation: descriptions, `guidance`,
   `pages`, and `note_templates` (key, name, description, starter Markdown).
   Preserve stable page keys and supported schema fields. Team-specific
   conventions belong in this definition, not in installed skill instructions.

If an agent asks Memory for a scope with no definition or pages, treat the empty result as setup guidance, not a disabled-feature error. Say that Knowledge has not been initialized, recommend a compatible template from the live catalog, and explain how to build it in Knowledge. Continue to analysis and commit only when the user asks to initialize; do not invent stored memories or silently create pages. A search with no matches in an already populated scope is just a search miss, not a reason to initialize again.

## Adapt to native entities

PARA distinguishes active outcomes, ongoing responsibilities, reusable
material, and inactive material. Apply that distinction to the owning scope:

| Concept   | Workspace knowledge                                                                  | Existing project knowledge                                                                                            |
| --------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Projects  | Link to existing Nuanu project knowledge.                                            | The project is already the container; start at overview/useful sections, without a nested Projects/This project root. |
| Areas     | Durable responsibility/topic sections; link relevant teams and accountable contacts. | Only relevant ongoing responsibilities; omit when unhelpful.                                                          |
| Resources | Shared explanations, research, procedures, and canonical Artifact links.             | Project references and links to shared resources, without copying the workspace library.                              |
| Archives  | Historical knowledge and useful links to completed project knowledge.                | Dated/superseded notes and replacement links.                                                                         |

Areas are knowledge categories, not new entities or a mandatory copy of teams.
For every template, reuse existing projects, teams, members, and agents through
supported stable links. An optional people index is navigation to existing
identities. Mentions do not assign ownership or grant access; agent capabilities
stay on agent records. Task status stays on Flow items, approval outcomes on
Decisions, and file versions on Artifacts. Archiving a note does not archive its
linked entity. Do not invent relation fields unsupported by the tool schema.

## Preview, initialize, and resume

Discover current full tool schemas before execution. Preserve the same target,
command IDs, initialization ID, and manifest fingerprint through retries.

- Stage selected pasted/uploaded sources with `stage_memory_initialization_input`
  when needed; use returned source identities/fingerprints in `inputs`.
- Call `analyze_memory_initialization` with the chosen blueprint ID/version,
  customized `definition`, current `expected_revision` (0 when absent), sources,
  and a command ID. Analysis freezes the definition and produces a manifest;
  it does not create Wiki pages.
- Present the actual target, structure, guide, proposed page actions, and
  warnings. Empty starter headings/questions are placeholders, not facts.
  Use `commit_memory_initialization` with the exact reviewed fingerprint and
  any supported selection. Follow returned review/Decision requirements.
  A request to choose and initialize supplies selection intent; do not add a
  separate mandatory template-selection approval.
- Read `get_memory_initialization` to verify status and result. On interruption
  or an uncertain response, inspect that same run first. Use
  `resume_memory_initialization` only for an incomplete resumable run; do not
  start another analysis to repeat completed work. Cancel only when requested.
- Return the verified knowledge/result links and whether initialization is
  completed, running, incomplete, or cancelled. After completion, read the
  saved definition and resulting pages; starting a Process is not completion.

If a required capability is unavailable, report the specific limitation.
Do not approximate initialization with untracked page creation or claim that
source support is already available on the connected server.

## Maintain the saved definition

Read `get_knowledge_definition`, retain its revision, and edit that returned
snapshot. `update_knowledge_definition` takes the full definition and
`expected_revision`; its result is the same scope-owned configuration the UI
uses. On conflict, fetch current state, reconcile the requested change, and
retry with that revision only after resolving any conflicting intent. Following
an uncertain write, read back before retrying.

Preserve template provenance and stable section keys. The live Wiki tree owns
existing page locations; `page_ids` maps definition keys to those pages. Editing
a guide, title, order, or future placement convention does not move, rename,
create, or archive existing pages. Handle requested page changes separately
through Wiki tools, previewing their effect. Upstream template changes never
replace the team's adopted guide. Fetch the current guide again for later
substantive work and follow its customized placement and page conventions.
