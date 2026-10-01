# External integrations

## What an integration connection does

The workspace **Integrations** page connects a member's external account so
Nuanu Flow's AI agents can act on that member's behalf. Each connection is
user-owned: only that user connects or disconnects it.

OAuth credentials stay with the hosted integration provider. Never ask the
user to paste a provider password, OAuth code, access token, or refresh token
into chat.

There are two separate permissions:

1. The member connects an external account.
2. The member explicitly grants that connected integration to an agent
   employee in the agent's configuration.

Connecting an account does not automatically expose it to every agent.

## Connect a supported provider

1. In the workspace's main sidebar, open **Integrations**.
2. Find the provider and choose **Connect**.
3. Complete the provider's hosted OAuth consent window.
4. Return to Nuanu Flow and wait for the card to show **Connected**.
5. When creating or editing a local agent, select only the integrations that
   agent needs.

For Gmail-, Slack-, or Instagram-like account questions, use this main
**Integrations** page. Do not send the user to **Workspace Settings →
Integrations** unless they specifically mean an administrator-installed app
integration.

Connection states shown by the page include **Not connected**, **Awaiting
authorization**, and **Connected**. If consent succeeds but the state remains
pending, close the popup, refresh the page once, and retry the connection. Do
not repeatedly authorize or share credentials.

## Current bundled catalog

At this codebase snapshot, the curated UI catalog contains:

- Email: Gmail, Outlook
- Chat: Slack, Telegram, Discord, WhatsApp
- Calendar and files: Google Calendar, Google Drive, Google Sheets
- Docs: Google Docs, Notion
- Development and project tools: GitHub, GitLab, Linear, Jira, Trello
- CRM and business: HubSpot, Salesforce, Zoom, Stripe, Twilio

The active deployment may expose a smaller or newer set. When the workspace is
known, `get_agent_creation_options` is authoritative: find the provider in its
`integrations` array and inspect `connected`. Use its `integrations_url` for
the workspace-specific page when available.

## Instagram

**Instagram is not in the curated integration catalog in this build, so a user
cannot currently connect it from the Nuanu Flow Integrations screen.** This is
not a missing-account or permission error, and the Q&A service must not invent
an Instagram Connect button.

Before giving that answer for a live workspace, check
`get_agent_creation_options` when possible because a newer deployment may
have added Instagram. Interpret the result as follows:

- Instagram absent: it is not supported in that environment.
- Instagram listed with `connected: false`: direct the user to the returned
  Integrations URL and the normal OAuth steps.
- Instagram listed with `connected: true`: the account is connected; the next
  step is to grant it to the intended agent.

Adding Instagram to the product requires an administrator/developer to add it
to the curated catalog and runtime allowlist and to verify the provider's
OAuth/tool support. A normal workspace member cannot solve an absent catalog
entry by re-authenticating.

## Disconnect a provider

Open **Integrations**, find the connected provider, and choose **Disconnect**.
This revokes Nuanu Flow's reference to that connected account for the current
user. Review affected agents before disconnecting because tasks that require
the provider may fail afterward.

## Availability language for answers

Report these separately:

- **Supported**: the provider is present in the live integration catalog.
- **Connected**: the current user completed OAuth for it.
- **Granted to an agent**: the provider is selected in that agent's
  allowlist.
- **Usable now**: a bounded agent action has succeeded.

Do not collapse those four states into “installed” or “working.”
