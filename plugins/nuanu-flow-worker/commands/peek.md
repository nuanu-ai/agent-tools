---
description: Show the current Nuanu Flow remote-worker state for this exact Codex conversation
---

Show one read-only snapshot of the Nuanu Flow worker attached to this exact
conversation.

1. Require `CODEX_THREAD_ID` (or the explicit `NUANU_OWNER_SESSION_ID`
   override). Never guess a session, choose the newest state directory, or
   query another conversation.
2. Run the observer bundled in the same installed plugin as this command:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worker/session_observer.mjs" peek
   ```

   In Codex, substitute the exact installed plugin root that supplied this
   command when `CLAUDE_PLUGIN_ROOT` is unavailable; do not scan plugin caches
   or select a version by recency.

3. Return its sanitized output verbatim. Exit `0` is a valid idle or active
   snapshot. Exit `2` means this conversation has no available attached state.

This command is read-only: it does not call Flow, claim or retry work, approve
a Decision, consume the next-prompt catch-up inbox, or alter the worker.
