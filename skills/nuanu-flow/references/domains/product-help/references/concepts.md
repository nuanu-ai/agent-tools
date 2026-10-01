# Nuanu Flow concepts

Use the visible product names below. The short distinctions are suitable for
direct answers; the details help with follow-up questions.

## The hierarchy

```text
Organization
└── Workspace
    ├── Projects
    │   ├── Flow items
    │   ├── Cycles
    │   ├── Modules
    │   ├── Views
    │   ├── Wiki
    │   ├── Intake
    │   └── Artifacts
    ├── Processes and runs
    ├── Agent employees
    ├── Decisions
    ├── Integrations
    ├── Teams
    └── Objectives
```

An organization is the account-level home. A workspace is the collaboration
boundary where people, projects, agents, processes, and settings live.

## Project

A **project** is the main container for goal-oriented, ongoing work. It has a
short identifier such as `ENG`, its own workflow states, members, and optional
features such as cycles, modules, views, wiki, intake, artifacts, and
automations.

Use a project when the work has a shared outcome, workflow, or team. A project
is not a single task and it is not an execution of a process.

## Flow item

A **Flow item** is the actionable building block inside a project, identified
like `ENG-42`. It can have a description, state, priority, assignees, labels,
estimate, dates, comments, attachments, sub-items, and relations.

Users may call it a task, ticket, card, or issue. In answers, call it a Flow
item. Its **state** is the project workflow step, commonly grouped as backlog,
unstarted, started, completed, or cancelled.

## Cycle

A **cycle** is a repeatable time box, similar to a sprint. Put Flow items into
a cycle to plan and measure what should be completed during a period. A Flow
item may move between cycles as planning changes.

## Module

A **module** groups related Flow items into a feature, phase, milestone, or
larger deliverable. Modules can span more than one cycle. Use cycles to answer
“when?”, and modules to answer “which larger outcome?”

## View

A **view** is a saved filter over Flow items. It does not copy the items; it
stores a useful way of finding and presenting them. Project views are shared
with project collaborators, while workspace views can span projects.

## Wiki

The **Wiki** is shared documentation and context for people and AI. Use it for
durable knowledge, instructions, notes, and background that should not live in
a single Flow item comment.

## Intake and triage

**Intake** collects incoming requests for a project before they become normal
Flow items in its workflow. It is an optional project feature.

**Triage** is the workspace-level place for reviewing and routing incoming
work. If either entry is missing, the user's role or the relevant feature
setting may be hiding it.

## Process and run

A **process** is a reusable BPMN workflow template. It defines the sequence and
branching of start events, human tasks, agent tasks, decisions, gateways,
notifications, webhooks, and end events.

A **run** is one execution of that template. The process is the recipe; a run
is one time the recipe is followed. Runs can start manually, on a schedule, or
from an event, depending on the configured start event.

Use a process for multi-step work with orchestration, approvals, agents,
branches, loops, or parallel work.

## Automation versus process

An **automation** is a compact event → action rule attached to project work,
such as reacting when a Flow item changes. A **process** is better when the
work has several steps, waits for humans, calls agents, needs decisions, or
must expose a run history.

## Decision

A **decision** is a human approval or choice gate created by a process run.
The run pauses until the assigned person responds. Approve normally advances,
deny follows its rejection branch, and refine can return work to an earlier
step when the process author wired that route.

The **Decisions** inbox is the cross-workspace place to find gates awaiting the
current user; a run view shows the same decision in process context.

## Agent employee

An **agent employee** is a reusable AI worker with a role, prompt, model,
skills, and explicitly allowed integrations.

- A **local agent** runs through Nuanu Flow's managed runtime.
- A **remote agent** is connected to an external coding-agent worker.

For local agents, editable configuration is a **draft**. Saving does not
create a version. **Publish version** creates an immutable executable version,
and new production work pins one exact version. Existing conversations,
running Processes, retries, refinements, and pinned schedules do not drift
when a newer version is published. Restoring an older version copies it into
the draft; publishing that draft creates a new monotonic version rather than
rewriting history.

Connecting an integration to a user account and granting it to an agent are
separate actions. Agents only receive the integrations selected in their
configuration.

## Artifact

An **artifact** is a versioned file or document in the workspace registry. It
can be organized in a logical folder and linked to a project, Flow item,
process run, or another entity. Use artifacts for durable outputs such as
reports, datasets, specifications, and PDFs; use temporary storage only for
scratch work.

## Team and objective

A **team** groups workspace members and projects. An **objective** is a
higher-level goal or portfolio that can roll up projects and make progress
visible beyond one project.

## Draft

A **draft** is unfinished work saved before it is published into the normal
workspace/project flow. Drafts can include Flow items and other supported
entities, depending on the screen.
