---
name: telegram
description: Use when a user wants to connect, verify, resume, or test a personal Telegram account or a Telegram group for a Nuanu Flow workspace, project, or team.
---

# Telegram linking

Guide the human through one short-lived link, keep checking the authoritative
Nuanu Flow state, and distinguish link preparation, verified connection, and
test delivery. Call pure reads through `execute_read_tool("<name>", {...})`
and mutations through `execute_tool("<name>", {...})`.

Ambient agent sessions cannot link Telegram. If a Telegram tool reports the
human-session guard, ask the user to continue from a human-authenticated proxy
or manual-token MCP session; do not retry from the ambient session.

When the requested target is unclear, ask one short question: personal account or group?
Do not start both flows by assumption.

## Personal account

1. Start or resume with `execute_read_tool("get_telegram_identity", {})`.
2. Treat the account as connected only when `linked && is_verified`. If it is
   connected, report the returned username when present.
   Do not send a test message automatically. Offer it as a separate check.
3. Otherwise, reuse an unexpired prior `verification_url` when it is still
   available in the live turn. For a fresh attempt, or when the prior link is
   expired or unavailable, call
   `execute_tool("prepare_telegram_identity_link", {})`. Show the returned URL
   as a clickable link and say: "Open this in Telegram, tap **Start**, then
   come back here. I'll keep checking for up to two minutes."
4. Poll `get_telegram_identity` every 3 seconds for at most 2 minutes. Stop as
   soon as `linked && is_verified`; then say the personal account is connected.
5. If the bound expires first, report `still_waiting`, say the link may still
   be usable until its own expiry, and offer to resume. On resume, check status
   first; do not create another link unless the account is still unlinked and
   the prior link is expired or unavailable.
6. Only when the user asks for delivery verification, call
   `execute_tool("send_telegram_test_message", {})`. Report delivery separately
   from connection status.

## Telegram group

1. Establish the exact scope: `workspace`, `project`, or `team`. Resolve a
   project or team with `list_projects` or `list_teams`; never guess its ID.
2. Call `list_communication_channels` at that exact scope and match exact names,
   not fuzzy guesses. Reuse a matching Telegram channel, especially an existing
   unlinked one, instead of creating a duplicate. If several exact candidates remain, ask the user to choose one.
3. If creation is needed, summarize the channel name and exact scope, then get
   explicit user confirmation. Only then call `create_communication_channel`
   with `confirmed: true`.
4. If the selected channel already has `linked: true`, report it connected and
   stop. Otherwise, reuse an unexpired prior command when it remains available
   in the live turn. For a fresh attempt, or when the command is expired or
   unavailable, call `prepare_communication_channel_link` with the same scope,
   entity ID when applicable, and channel ID.
5. Show `bot_url` and `command` exactly as returned. Say: "Add or open this bot
   in the intended Telegram group, post the exact `/link` command there, and
   come back here. I'll keep checking for up to two minutes."
6. Poll `get_communication_channel` through the same scope every 3 seconds for
   at most 2 minutes. Only backend `linked: true` proves the group connection;
   preparing a command does not.
7. On timeout, report `still_waiting` and offer to resume. Reuse an unexpired
   command; when resuming, read the same channel first rather than creating a
   duplicate.

## Quick reference

| State                            | Meaning                                    |
| -------------------------------- | ------------------------------------------ |
| Link or command returned         | Ready for the human; not connected yet     |
| Personal `linked && is_verified` | Personal account connected                 |
| Group `linked: true`             | Exact group bound to the selected scope    |
| Test message `delivered: true`   | Delivery works; separate from linking      |
| `still_waiting`                  | Bounded polling ended; resume safely later |

## Common mistakes

- Never claim success from a generated URL, `/link` command, browser open, or
  elapsed time. Read backend state.
- Never store or repeat verification URLs, tokens, or `/link` codes in files,
  artifacts, logs, fixtures, memory, or summaries. Show them only in the live
  linking turn.
- Never create a group channel without confirmation or silently change its
  scope. Never expose a Telegram chat ID.

## Tools Used

`execute_read_tool`, `execute_tool`, `get_telegram_identity`, `prepare_telegram_identity_link`, `send_telegram_test_message`, `list_communication_channels`, `create_communication_channel`, `get_communication_channel`, `prepare_communication_channel_link`, `list_projects`, `list_teams`
