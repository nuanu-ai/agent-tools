---
name: wiki
description: Create, organize, search, share, archive, and safely restore Nuanu Flow Wiki pages across organization, workspace, team, and project scopes.
---

# Wiki

Use this skill for collaborative product documentation: handbooks, policies,
runbooks, project specifications, research notes, and other pages people edit
in Nuanu Flow. Wiki pages are not Artifacts: Artifacts are versioned files and
run outputs, while Wiki pages are living documents with a hierarchy and editor.

Call pure reads through `execute_read_tool("<name>", {...})` and mutations
through `execute_tool("<name>", {...})`.

## 1. Resolve the owning scope

Use exactly one concrete scope:

- company or workspace handbook → `workspace_slug`;
- team runbook → `workspace_slug` + `team_id`;
- project specification or project notes → `workspace_slug` +
  `project_id` or exact `project_identifier`;
- organization-wide policy → `organization_slug`.

Project Wiki uses the same Page entity and the same Wiki tools. Do not invent a
separate “project pages” workflow. Aggregate workspace and organization views
are projections: mutations still target one owning scope.

## 2. Inspect before writing

Call `list_wiki_pages`, then `search_wiki_pages` by likely titles. For
workspace- or organization-wide discovery, pass `include_derived: true` to
include accessible team and project Wikis. Search is title-only, not
full-content search. Use bounded `get_wiki_page` reads when content inspection
is necessary.

Fetch likely matches before creating a page. Extend an existing page when that
is what the user means; do not create near-duplicates.

## 3. Write the canonical content format

`description_html` is HTML, not Markdown. Use semantic, compact HTML such as
`<h2>`, `<p>`, `<ul>`, and `<li>`. When the request is an append or surgical
edit:

1. read the current page;
2. preserve content outside the requested change;
3. submit the complete replacement HTML with `update_wiki_page`;
4. read the page back.

Never replace a non-empty page with an empty body unless the user explicitly
asked to clear it.

## 4. Maintain hierarchy

Use `is_folder: true` for navigation containers, not fake content pages.
Create or move a page with `parent_id` inside the same scope. Pass
`parent_id: null` to move a page to the root. Use `sort_order` only when
sibling order matters. After moving or reordering, read the page back and
verify `parent_id` and `sort_order`.

Set `is_ai_enabled` intentionally. It makes the page eligible for the
product's ambient AI context; do not claim that it automatically indexes or
injects the page unless the current runtime path was separately verified.

## 5. Prefer archive

Use `archive_wiki_page` for normal removal; it archives the descendant
subtree and can be reversed with `restore_wiki_page`.

Use `delete_wiki_page` only after the user explicitly asks for permanent
deletion. Read the page first, ensure it is archived, then pass its exact
current title as `confirm_name`.

## 6. Protect external sharing

`publish_wiki_page` makes the page readable to anyone with the link. Before
calling it:

1. state the page title and scope;
2. state that the page contents become externally readable without workspace
   membership;
3. obtain explicit user confirmation;
4. pass `confirm_public: true`;
5. return the verified `public_url`.

Publishing is supported for workspace, team, and project Wiki pages.
Organization Wiki publishing is not currently supported. Use
`unpublish_wiki_page` to revoke a link. Republishing after revocation mints a
new link.

## 7. Restore versions safely

Version history is supported for workspace, team, and project Wiki pages:

1. `list_wiki_page_versions`;
2. `get_wiki_page` for the current body;
3. `get_wiki_page_version` for the selected historical body;
4. summarize what will be replaced;
5. restore only the explicitly selected version with
   `restore_wiki_page_version`;
6. verify with `get_wiki_page`.

Organization Wiki version history is not currently supported.

## 8. Finish with evidence

For any mutation, read the page back or list its scope. Report the page title,
scope, ID, private `web_url`, and public URL when one exists. For hierarchy
changes, include the verified parent. For sharing or restore, include the
verified final state.

## Tools Used

`list_wiki_pages`, `get_wiki_page`, `search_wiki_pages`, `create_wiki_page`, `update_wiki_page`, `archive_wiki_page`, `restore_wiki_page`, `delete_wiki_page`, `publish_wiki_page`, `unpublish_wiki_page`, `list_wiki_page_versions`, `get_wiki_page_version`, `restore_wiki_page_version`
