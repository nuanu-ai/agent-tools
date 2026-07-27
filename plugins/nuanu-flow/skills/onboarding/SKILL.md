---
name: onboarding
description: Use when a user asks to set up Nuanu Flow, continue first-run setup, create a first workspace, or resume an authenticated account whose onboarding is incomplete.
---

# Nuanu Flow onboarding

Run first-time setup as a resumable, server-driven conversation. Call catalog
tools through `execute_tool("<name>", {...})`.

When this skill is entered from the post-install startup prompt, do not ask the
user to type another continuation message. Start the resumable loop
immediately. If the thread already establishes that onboarding is complete,
do not repeat the check or any completed mutation.

## The resumable loop

Always start, including after an interrupted session, with:

```text
execute_tool("onboarding_next", {})
```

When the account has several workspaces, show only the returned workspace
names and slugs, get an explicit choice, and repeat the call with
`workspace_slug`. Never guess.

Handle exactly the returned `current_step`. After every confirmed mutation,
call `onboarding_next` again, preserving the explicit `workspace_slug` when
one is needed. The API is authoritative: do not infer a later step, edit
onboarding flags directly, or repeat completed work.

Pause when a real user choice is required. Stop only when the returned step is
`complete` and `complete_onboarding` succeeds.

## Step: profile

Briefly explain that first and last name identify the user's actions and
collaboration in Nuanu Flow. Ask for first name and last name. Offer role and
primary use case as optional, not required.

Read back the values and call `update_onboarding_profile` only after
confirmation. Do not update any other profile fields.

## Step: workspace

Explain:

> A workspace is the top-level home for your organization or team. It holds
> shared context, members, projects, and processes.

Ask for:

1. a workspace name;
2. one freeform description, in the user's own words, of what the
   organization or team does.

Propose a lowercase, hyphenated URL slug. Read back the name, slug, and exact
meaning of the description, then get explicit confirmation before calling
`create_workspace`. Keep the confirmed description available for the next
step; do not turn it into invented strategy.

## Step: workspace_context

The `Company` wiki page is shared context for members and agents. Use
`list_wiki_pages` first so retries do not create duplicates. Create the page
with `create_wiki_page`, or use `update_wiki_page` when the Company page
already exists.

Build concise HTML from only the user's confirmed freeform description.
Preserve their meaning. Do not invent customers, goals, dates, team structure,
or operating practices. Ask for missing information instead of guessing.

## Step: teammates

Suggest inviting teammates and say clearly that this can be done later.

- If the user chooses later, call `update_onboarding_progress` with
  `{"step":"teammates","decision":"later"}`.
- If the user wants invitations now, collect each email and role. Explain
  that production invitations queue real email while local development may
  use console-only delivery, read back the full email-and-role list, get a
  separate confirmation before `invite_workspace_members`, and report its
  returned delivery status exactly.

After the decision or successful invitations, call `onboarding_next`.

## Step: orientation

Explain exactly:

- Projects hold ongoing, evolving task work.
- Processes are repeatable workflows that run on a schedule or in response to
  an event.

The explanation itself completes orientation. Immediately record it with
`update_onboarding_progress` using
`{"step":"orientation","acknowledged":true}`, call `onboarding_next`, and
continue to completion without waiting for another reply. Do not create a
project or process implicitly.

## Step: complete

Call `complete_onboarding` to validate that no requirement is outstanding.
If it returns an earlier current step, resume that step rather than forcing
completion.

On success, summarize the confirmed profile, workspace, Company context,
teammate decision, and orientation. End with the clickable `ui_url` returned
by the tool; never invent or hardcode the host. Then offer `project-setup` for
a first project, `bpmn-processes` for a process, or no additional creation.
This offer is optional follow-up and must not block onboarding completion.

Do not create `.nuanu-flow.json` during authentication or account onboarding:
there is no confirmed project binding yet. If the user chooses
`project-setup`, that skill may offer to bind the current Git repository after
the workspace and project identifier are confirmed.

## Tools Used

`execute_tool`, `onboarding_next`, `update_onboarding_profile`, `create_workspace`, `list_wiki_pages`, `create_wiki_page`, `update_wiki_page`, `invite_workspace_members`, `update_onboarding_progress`, `complete_onboarding`
