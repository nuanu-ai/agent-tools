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

Select only from `get_agent_creation_options`. Use this sequence:

1. Remove unavailable models and any model missing a required input modality,
   context size, tool calling, structured output, or reasoning capability.
2. Prefer a fast, economical fixed model for classification, extraction,
   routing, bounded transformations, and frequent low-risk jobs.
3. Prefer a stronger fixed model for ambiguous synthesis, complex planning,
   code changes, or expensive mistakes.
4. Compare the remaining catalog pricing and `recommended` marker. If two
   fixed models fit, start with the cheaper/faster one and let smoke tests
   justify an upgrade.
5. If the catalog contains the exact ID `openrouter/auto`, consider it when
   the agent receives materially different kinds of jobs or when model choice
   is still being discovered. OpenRouter's Auto Router chooses from the prompt
   and reports the routed model. Do not use it merely as a fashionable default:
   a stable specialist benefits from a fixed model's reproducibility, and no
   router proves quality for this role without representative tests.

Do not invent a model ID from documentation or memory. The active catalog may
exclude a model for availability, privacy, modality, or tool-use reasons.

Build a small requirement matrix before choosing the model. Each representative
job must map to its required input modality, output modality, context size,
tool-calling and structured-output support, hosted capabilities, connected
providers, and instruction skills. A candidate is valid only if every required
row is satisfied. Model modalities, executable capabilities, and skills are
separate dimensions: image input is not image generation, a Markdown writer is
not a PDF renderer, and attaching an instruction skill cannot create a tool the
runtime does not have. If the catalog has no valid candidate, narrow the job or
use a capable remote worker instead of selecting the closest model.

Remote agents choose their model in the external worker, so do not attach a
Nuanu Flow local model to a remote identity.

Choose the remote connection deliberately. A **Nuanu worker** is appropriate
for Codex, Claude Code, or another harness that pulls Process tasks, receives a
task-scoped internal MCP descriptor, and may work in the admitted repository.
An **A2A agent** is appropriate for an already hosted opaque service with a
public Agent Card and reachable HTTP+JSON interface. The Agent Card is a
discovered projection: Nuanu pins its safe metadata and hash in an immutable
Agent Employee version, while Nuanu's own task request, result, Artifact,
authorization, and Process models remain authoritative. Do not create both
connections for one agent identity or treat advertised A2A skills as grants.

## Ground niche roles before prompting

Do a short design-time research pass when specialist vocabulary, regulation,
professional standards, or current examples materially affect the agent:

1. Search two to four primary or authoritative sources plus at most two useful
   comparable examples.
2. Extract the expected inputs, output conventions, source hierarchy, common
   failure modes, and escalation boundaries.
3. Turn those findings into original operating rules. Never paste another
   agent's prompt or treat an example as authoritative.
4. Record time-sensitive assumptions in the agent card.

Use any trustworthy search/fetch capability available to the current host. If
none is available, say that the research pass was unavailable and ask for one
authoritative example only when its absence would materially change the
design. Design-time research does not by itself justify granting the created
agent web access.

## Least-privilege capabilities

Nuanu Flow's internal MCP is built into every local agent and executes with the
agent's workspace role. Process executions narrow it further with a
short-lived task identity and the admitted step capability grant. It is not an
attached `mcp_servers` capability. Apply
least privilege through the agent role and normal approval boundaries; use
`mcp_servers` only for additional external providers.

For each proposed capability, name the representative job that requires it:

| Capability          | Add only when                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Tool                | The agent must perform that exact platform action.                                                     |
| Curated skill       | The role repeatedly needs the skill's workflow or domain rules.                                        |
| Integration         | A representative job requires data or an action in that service, and it is connected.                  |
| External MCP server | A representative job requires discovered tools from that server, and transport plus auth are verified. |
| Admin role          | The agent must administer workspace-wide configuration and the user explicitly accepts that authority. |

Select local-Agent instruction skills with the same discipline. Attach every
exact catalog skill whose workflow is required by a representative job, and
none merely because it sounds related. Durable Process output publication by a
local Agent requires the `artifacts` skill; Process authoring requires
`bpmn-processes`. A Nuanu-native remote worker instead receives the full bundled
skill set from its installed combined plugin, so an empty attached-skill list is
not evidence that `artifacts` is unavailable. External A2A Agents are judged
from their advertised Agent Card. Skills explain
how to operate authorized tools but never grant tool access or compensate for a
missing model output modality. Verify the saved/published agent still has the
approved model, tool slugs, connections, and skill IDs after creation.

If no representative job justifies a capability, omit it. Separate read,
write, communication, and destructive permissions in the agent card. Any real
external message, invitation, payment, publication, deletion, or credential
change still needs the normal user-confirmation boundary.

Use the exact capability slugs returned by `get_agent_creation_options`:

- `web.search` for discovering current public sources;
- `web.fetch` for reading known public URLs or grounding a search result;
- `sandbox.execute` only for bounded code or data transformations that need
  execution. Treat it as high risk, ephemeral, and network-blocked.

Do not grant both web capabilities automatically: a known-URL reader may only
need fetch, while discovery generally needs search and often fetch. A skill is
an instruction pack; a capability is an executable hosted tool; an integration
is access to a connected external service. An MCP server is a separately
authenticated tool provider. One does not imply the others.

Durable files and external deliverables are Process outputs, not Agent Employee
configuration. Declare their allowed roles and kinds on the Agent Task. The
agent creates file-backed Artifacts through internal MCP or proposes an
allowlisted external candidate such as `git.commit`; Nuanu Flow resolves and
verifies the exact immutable version before the step succeeds.

## Connector readiness

- Treat the API catalog's `connected` value as authoritative for the current
  user and workspace.
- Never claim a disconnected integration is usable.
- Share the environment-aware integration settings URL and let the user
  connect it.
- Create without the integration only when the remaining agent is still
  useful and the user accepts the reduced capability.
- Do not request OAuth tokens or third-party secrets in chat.
- For MCP, distinguish saved configuration, successful login, reachable
  transport, and discovered tools. Only `connected` proves runtime readiness.
- MCP credentials stay on the workspace connection. Published agent versions
  contain a connection ID and public configuration hash only.

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
- OpenRouter, [Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- OpenRouter, [Models API](https://openrouter.ai/docs/guides/overview/models)
- GitHub, [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- Microsoft, [Best practices for generative orchestration instructions](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/generative-mode-guidance)
- Atlassian, [Rovo agent manifest reference](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/)
- Linear, [Agents API](https://linear.app/developers/agents)
- GitHub, [Adding self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
