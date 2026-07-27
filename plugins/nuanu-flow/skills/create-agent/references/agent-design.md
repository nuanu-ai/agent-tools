# Agent design rubric

Use this reference after environment discovery and before presenting an agent
card. It summarizes durable design principles; the active Nuanu Flow catalog,
not this document, is authoritative for concrete model and connector IDs.

## When an agent is justified

Choose an agent when success requires interpretation, judgment, adaptive tool
choice, or useful progress despite incomplete inputs. Prefer a Process when
the work is a known sequence with stable branches, schedules, events,
approvals, or hand-offs. Prefer a fixed automation when one deterministic
action is enough.

Start with one focused agent. Add specialized agents only when task boundaries
are clear enough that each has a distinct purpose, context, capabilities, and
evaluation set.

## System prompt template

Write short, operational instructions in this order:

1. **Role:** what the agent is and the expertise it applies.
2. **Objective:** the outcome it owns and the definition of success.
3. **Scope:** jobs it should accept and important non-goals.
4. **Operating loop:** inspect context, plan briefly, use the minimum necessary
   tools, verify the result, and report.
5. **Inputs and context:** authoritative sources and how to handle stale or
   conflicting information.
6. **Capability policy:** when each granted tool, skill, or integration is
   appropriate; do not restate schemas.
7. **Output contract:** format, evidence, detail, and destination.
8. **Ambiguity:** make reversible assumptions when safe; ask one targeted
   question when the answer materially changes the action.
9. **Escalation:** stop for missing authority, irreversible effects,
   credentials, external communications, or safety concerns.
10. **Prohibited actions:** clear boundaries specific to the role.

Avoid personality filler, duplicated platform rules, broad “use every tool”
instructions, and hidden success criteria.

## Model selection

Select from `get_agent_creation_options`:

- Prefer a fast, economical model for classification, extraction, routing,
  bounded transformations, and frequent low-risk jobs.
- Prefer a stronger reasoning model for ambiguous synthesis, complex planning,
  code changes, or high-cost mistakes.
- Prefer a model with the context and modality required by representative
  inputs; do not select capability “just in case.”
- If two models satisfy the brief, start with the cheaper/faster one and use
  the smoke tests to justify an upgrade.

Remote agents choose their model in the external worker, so do not attach a
Nuanu Flow local model to a remote identity.

## Least-privilege capabilities

For each proposed capability, name the representative job that requires it:

| Capability    | Add only when                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Tool          | The agent must perform that exact platform action.                                                     |
| Curated skill | The role repeatedly needs the skill's workflow or domain rules.                                        |
| Integration   | A representative job requires data or an action in that service, and it is connected.                  |
| Admin role    | The agent must administer workspace-wide configuration and the user explicitly accepts that authority. |

If no representative job justifies a capability, omit it. Separate read,
write, communication, and destructive permissions in the agent card. Any real
external message, invitation, payment, publication, deletion, or credential
change still needs the normal user-confirmation boundary.

## Connector readiness

- Treat the API catalog's `connected` value as authoritative for the current
  user and workspace.
- Never claim a disconnected integration is usable.
- Share the environment-aware integration settings URL and let the user
  connect it.
- Create without the integration only when the remaining agent is still
  useful and the user accepts the reduced capability.
- Do not request OAuth tokens or third-party secrets in chat.

## Smoke-test scenarios

Create three to five scenarios before creation:

1. **Happy path:** representative input and the expected useful output.
2. **Incomplete context:** verify one targeted question or a clearly labeled,
   reversible assumption.
3. **Tool or connector failure:** verify bounded retry, honest failure, and
   actionable recovery.
4. **Unsafe or out-of-scope request:** verify refusal or escalation without
   side effects.
5. **Quality edge case:** the most likely source of a plausible but wrong
   answer for this role.

For every scenario record input, expected behavior, forbidden behavior, and
observable pass criteria. A configuration smoke test verifies identity and
capabilities; it is not a substitute for evaluating live task quality.

## Example: local research agent

- **Purpose:** turn a market question into a short sourced opportunity brief.
- **Runtime:** local; Member role.
- **Capabilities:** research skill and one connected knowledge source; no
  workspace administration or outbound messaging.
- **Prompt emphasis:** distinguish evidence from inference, cite sources,
  report uncertainty, and ask when geography or customer segment changes the
  answer materially.
- **Tests:** complete brief, missing market boundary, unavailable source, and
  request to publish without approval.

## Example: remote coding worker

- **Purpose:** execute assigned process coding tasks in a checked-out
  repository and return verified changes.
- **Runtime:** remote; Member role.
- **Capabilities:** supplied by the Codex worker and task-scoped Flow
  credential, not duplicated as local-agent integrations.
- **Prompt emphasis:** respect repository instructions, preserve unrelated
  changes, run focused validation, and stop before unapproved deployment or
  destructive actions.
- **Tests:** bounded bug fix, underspecified acceptance criteria, failing test
  infrastructure, and request to expose or persist credentials.

## Sources

- OpenAI, [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- GitHub, [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- Microsoft, [Best practices for generative orchestration instructions](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/generative-mode-guidance)
- Atlassian, [Rovo agent manifest reference](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/)
- Linear, [Agents API](https://linear.app/developers/agents)
- GitHub, [Adding self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
