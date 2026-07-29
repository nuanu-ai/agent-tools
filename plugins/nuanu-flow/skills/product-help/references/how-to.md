# Common Nuanu Flow UI workflows

UI paths below start inside the selected workspace. Labels can be hidden by
role or by a project feature setting.

## Create a project

1. Open **Projects** in the workspace sidebar.
2. Choose **Add project** or **New project**.
3. Enter a name and a short identifier.
4. Add members and adjust states, labels, estimates, and optional features as
   needed.

Use a project for a continuing body of work, not for one standalone task.

## Create a Flow item

1. Open the project.
2. Select **Flow items**.
3. Choose **New flow item**.
4. Give it a clear outcome-focused title and enough description to define
   done.
5. Set the state, priority, assignee, labels, estimate, cycle, or module when
   those fields are useful.

The global **New flow item** action can also create an item after the project
is selected.

## Plan with cycles

1. Open a project and choose **Cycles**.
2. Create a cycle with a start and end date.
3. Add existing Flow items or create new ones in that cycle.
4. Use the cycle view to track the time-boxed commitment.

If **Cycles** is missing, enable it in the project's feature settings.

## Group work into a module

1. Open a project and choose **Modules**.
2. Create a module for the feature, phase, or milestone.
3. Add related Flow items, even when they span multiple cycles.

If **Modules** is missing, enable it in the project's feature settings.

## Save a view

1. Filter or group Flow items into the arrangement you need.
2. Save it as a **View**.
3. Reopen it from the project's **Views** entry. Use workspace Views when the
   filter should span projects.

Views save the query and presentation; they do not duplicate Flow items.

## Add shared knowledge

Open **Wiki** at workspace or project level, create a page, and put durable
context there. Prefer Wiki for reusable documentation; use a Flow item
description or comment for information specific to one piece of work.

## Create and run a process

1. Open **Processes** in the workspace sidebar.
2. Create a process template or open an existing one.
3. Build the flow from one start event through tasks, decisions, and gateways
   to one or more end events.
4. Validate the graph, fix reported structural problems, and activate it.
5. Start a manual run, or configure the start event for a schedule/event.
6. Follow the run view to see the active step, completed steps, decisions, and
   failures.

A template must be activated before it accepts new runs. Editing the template
does not rewrite runs that already exist.

## Respond to a decision

1. Open **Decisions** in the workspace sidebar, or open the relevant process
   run.
2. Select the pending decision.
3. Review its body and attached artifacts.
4. Choose the configured response, such as approve, deny, refine, or a custom
   option.

The process author controls where each answer goes. “Refine” only repeats work
when the process has a route back to the producing step.

## Create an agent employee

1. Open the workspace's **Agents** area.
2. Choose a local or remote runtime.
3. Define the agent's role, prompt, model, skills, and least-privilege
   integrations.
4. For a local agent, save and test it in a bounded task.
5. For a remote agent, follow the generated enrollment prompt on the machine
   that will run the worker.

External accounts must be connected under **Integrations** before they can be
granted to an agent. A connection is user-owned; an agent's allowlist is
separate.

## Find or add an artifact

Open **Artifacts** at workspace or project level. Upload or create the file,
use a logical folder when helpful, and link it to the Flow item, project, or
run that gives it context. New revisions should version the same artifact
instead of creating unrelated copies.

## Review incoming work

- Use project **Intake** for requests waiting to be accepted into that
  project's workflow.
- Use workspace **Triage** for broader incoming work that needs review or
  routing.

If Intake is unavailable, enable the feature in project settings. Access can
also depend on the user's workspace/project role.

## Locate workspace-wide goals and groups

- Open **Teams** to group people and projects.
- Open **Objectives** to manage higher-level goals and see project rollups.
- Open **Your work** to focus on Flow items assigned to the current user.
- Open **Drafts** to resume unfinished drafts.

## Troubleshooting a missing menu item

Check these in order:

1. Confirm that the correct organization, workspace, and project are selected.
2. Check whether the feature is project-level or workspace-level.
3. Check the project feature settings for Cycles, Modules, Views, Wiki, or
   Intake.
4. Confirm that the user is a workspace/project member with the needed role.
5. If the question concerns a provider or agent capability, check the live
   environment instead of assuming every deployment has the same catalog.
