---
name: product-help
description: Answer Nuanu Flow product questions and UI how-tos. Use whenever the user asks what a feature means, where to find it, how to use the app, how to connect an external service such as Instagram, or how projects, Flow items, cycles, modules, views, wiki, processes, runs, agents, decisions, artifacts, teams, objectives, triage, and integrations relate. Read-only by default.
---

# Nuanu Flow product help and Q&A

Use this skill as the product knowledge base for questions about working with
Nuanu Flow. It is for explanation and navigation, not for silently changing
the user's workspace.

## Answer contract

1. Answer the user's actual question in the first sentence.
2. Use the product's visible terms, especially **Flow item**. Treat “task”,
   “ticket”, and “issue” as aliases, but do not make the internal `issue` name
   the primary term.
3. For a how-to, give the shortest UI path and only the steps needed to finish
   it. Mention a permission or feature-setting dependency only when it can
   hide or block the action.
4. Distinguish:
   - what the feature **is**;
   - where it appears in the **UI**;
   - whether it is **available in this environment**.
5. Read-only by default. A question such as “How do I create a project?” does
   not authorize creating one. If the user asks the agent to perform the
   operation, switch to the operational skill named below.
6. Never invent a button, provider, plan entitlement, or connection status.
   Say plainly when the current build does not expose something.

## Load only the relevant reference

- Feature meaning, hierarchy, comparisons, and terminology:
  [references/concepts.md](references/concepts.md)
- Common UI workflows and navigation:
  [references/how-to.md](references/how-to.md)
- External account connections, supported providers, and Instagram:
  [references/integrations.md](references/integrations.md)

Read more than one reference only when the question crosses those boundaries.

## Freshness and live availability

The bundled references describe the codebase at publication time. Product
concepts are stable; provider catalogs and enabled project features can vary
by deployment and workspace.

For “Can I connect/use provider X?”:

1. If the workspace slug is already known and Flow MCP is available, call
   `execute_tool("get_agent_creation_options", {"workspace_slug":"..."})`.
2. Match the provider by exact integration `slug` or display `name`.
3. Report separately whether it is listed and whether `connected` is true.
4. Use the returned `integrations_url` when present.
5. If a live check is unavailable, answer from the bundled catalog and say
   that workspace availability may differ.

Do not run onboarding merely to answer a product question, and do not ask the
user to authenticate unless they requested a live, workspace-specific check.

## When the question becomes an action

Route requested mutations to the narrowest skill:

| Requested action                                            | Skill            |
| ----------------------------------------------------------- | ---------------- |
| Finish first-run account/workspace setup                    | `onboarding`     |
| Create or configure a project                               | `project-setup`  |
| Create, find, or update a Flow item, cycle, module, or view | `work-items`     |
| Create or operate a process/run/decision                    | `bpmn-processes` |
| Create or configure an agent employee                       | `create-agent`   |
| Store or link a file                                        | `artifacts`      |

Connecting an external account is currently a user-owned OAuth action in the
web UI. Explain the path and let the user complete the provider consent; never
request or handle their provider password, OAuth code, or token.

## Tools Used

`execute_tool`, `get_agent_creation_options`
