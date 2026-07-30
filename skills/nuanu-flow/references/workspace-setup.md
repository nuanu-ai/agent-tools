# Workspace setup

This skill enriches a workspace that already exists. It does not create a
workspace and is not the state machine for first-run setup. For a new account,
zero workspaces, or an interrupted first-run flow, use the `onboarding` skill
first.

Call tools via `execute_tool("<name>", {...})`. The flow is deliberately
conversational-first: **brief → wiki → objectives + milestones → members →
hand-off**. Do not create anything before step 1 is done.

## 1. Brief the user (no tools yet)

Interview, don't assume. You need, at minimum:

- What the company/org does, in two or three sentences, and who its customers are.
- The top goals for the next 6–12 months — outcomes, not activities — with
  rough dates where they exist (launches, external deadlines, funding gates).
- Team shape: roughly who does what, and how many people are joining the
  workspace.

Ask a few focused questions rather than a survey; follow up until you could
state the objectives yourself. Reflect the brief back in one short paragraph
and get a confirmation before proceeding.

## 2. Company wiki page

The wiki page is the workspace's shared context — members and agents read it.
Follow the dedicated `wiki` skill for duplicate checks, HTML content, tree
placement, publishing safeguards, and read-back verification.

- Check first: `list_wiki_pages` (workspace scope). If a company page already
  exists, `update_wiki_page` instead of duplicating.
- `create_wiki_page` with `name: "Company"` and `description_html` structured
  as: **About** (what/why), **Customers**, **How we work** (team shape,
  cadence), **Goals** (the confirmed brief summary). Keep it tight — a page
  people actually read, not a data dump.

## 3. Objectives + milestones

Propose the set in chat first — typically **2–4 objectives** phrased as
outcomes ("Activation to 40%", not "Improve onboarding") — and confirm before
creating.

- `create_objective` — `name`, `description` (why this matters + how it will
  be judged), `start_date`/`end_date` when the brief gives a horizon.
- `create_objective_milestone` per dated commitment on that objective —
  `name`, `target_date` (YYYY-MM-DD), `description` of what "reached" means.
  Milestones are commitments to dates (launches, releases, external
  deadlines), not tasks; if it has no meaningful date, it isn't a milestone.
- Re-runs: `list_objectives` / `list_objective_milestones` first and extend
  rather than duplicate.

## 4. Members (always ask, never assume)

Ask whether they want to invite people now. If yes, collect email + role per
person — role `20` admin, `15` member, `5` guest (default to member when
unsure) — then **read the final list back for confirmation**:
`invite_workspace_members` sends real emails. If they'd rather do it later,
point to Settings → Members.

## 5. Hand off

Projects are out of scope here — offer the **project-setup** skill next for
the first concrete workstream, and mention that Teams and Functions (routing
badges) can be configured in the workspace UI once people join.

## Tools Used

`get_workspace`, `list_wiki_pages`, `create_wiki_page`, `update_wiki_page`, `list_objectives`, `create_objective`, `list_objective_milestones`, `create_objective_milestone`, `list_workspace_members`, `invite_workspace_members`
