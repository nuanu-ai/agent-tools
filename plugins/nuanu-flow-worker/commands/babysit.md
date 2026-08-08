---
description: Follow sanitized Nuanu Flow remote-worker milestones for this exact Codex conversation
argument-hint: [timeout-seconds]
---

Follow the current Nuanu Flow remote task attached to this exact conversation
and print each retained or new sanitized milestone once.

1. Require `CODEX_THREAD_ID` (or the explicit `NUANU_OWNER_SESSION_ID`
   override). Never guess a session, choose the newest state directory, or
   query another conversation.
2. Run the observer bundled in the same installed plugin as this command in
   the foreground:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worker/session_observer.mjs" babysit
   ```

   If the user supplied a positive timeout, append `--timeout <seconds>`. The
   default is 600 seconds and the observer caps it at 1800 seconds. In Codex,
   substitute the exact installed plugin root that supplied this command when
   `CLAUDE_PLUGIN_ROOT` is unavailable; do not scan plugin caches or select a
   version by recency.

3. Relay new lines as they arrive. Exit `0` means the captured task became
   terminal, was already idle, or the observer was interrupted. Exit `2`
   means session state is unavailable. Exit `3` is a watch timeout while the
   task remains active, not a task failure.

Ctrl-C stops only this read-only observer. It does not stop, cancel, retry, or
otherwise alter the remote worker or the Flow task, and it does not consume
the next-prompt catch-up inbox.
