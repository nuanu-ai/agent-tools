---
name: onboarding
description: Use when a user asks to set up Nuanu Flow, continue first-run setup, create a first workspace, or an authenticated account has zero workspaces.
---

# Nuanu Flow onboarding

Make first-run setup conversational and state-aware. Call tools through
`execute_tool("<name>", {...})`, and do not mutate anything until the user has
confirmed the proposed setup.

## Start with account state

Call `list_workspaces` once, then follow exactly one branch:

| Result          | Action                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| zero workspaces | Interview, confirm, create the first workspace, then enrich it             |
| one workspace   | Inspect it and offer enrichment only when it is genuinely empty            |
| many workspaces | Show name + slug choices and ask the user to select one before scoped work |

Never guess a workspace when more than one exists.

## Zero workspaces

Ask a few focused questions at a time. Capture:

- workspace name and desired URL slug;
- what the business does and who its customers are;
- the top outcomes for the next 6–12 months and any meaningful dates;
- team shape and whether anyone should be invited now.

Suggest a lowercase hyphenated slug when needed. Read back the workspace
name/slug, business summary, intended outcomes, dates, and team plan. Ask for
explicit confirmation, then call `create_workspace`.

After creation, **REQUIRED SUB-SKILL:** Use `workspace-setup` with the confirmed
brief to create the Company context, objectives, dated milestones, and optional
invites. Before sending invitations, read the final invite list back with each
email and role and get a separate confirmation.

## One workspace

Use its slug to call `list_projects`, `list_wiki_pages`, and `list_objectives`.
A workspace is empty only when it has no projects, no Company wiki page, and no objectives.

- If all three are empty, explain what is missing and offer to run
  `workspace-setup`. Begin its interview only after the user agrees.
- If any one exists, treat the account as already started. Confirm the active
  workspace and ask what the user wants to do next; do not recreate or
  overwrite setup.

## Many workspaces

Present only safe choices from `list_workspaces`: workspace name and slug. Ask
for an explicit selection. Continue the one-workspace inspection only after
the user chooses.

## Finish

Summarize what was created and what was left unchanged. Offer `project-setup`
for the first workstream; never create a project implicitly.

## Tools Used

`execute_tool`, `list_workspaces`, `create_workspace`, `get_workspace`, `list_projects`, `list_wiki_pages`, `list_objectives`
