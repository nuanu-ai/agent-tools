---
name: human-input
description: Ask a human for a small decision or a few typed values while an agent is executing.
---

# Human input

Use `request_human` only when the answer changes what the agent should do.

- Prefer `choices` whenever the answer can be bounded. This keeps the fast Decision/swiper interaction.
- Use `fields` only for 1 to 5 small values: `text`, `number`, `boolean`, `date`, or `select`.
- Use a Human Task when the person must perform work, inspect files, upload evidence, or produce a deliverable.
- Use a normal message, activity entry, or notification when no response is needed. Never create a Decision merely to announce progress.
- Never request passwords, tokens, credentials, payment-card data, or other secrets.
- `blocking: true` means execution cannot safely continue. Call `request_human`, then stop the current turn.
- `blocking: false` is advisory. Continue immediately; its response informs future work and never rewinds completed work.
- Do not poll repeatedly. The remote worker resumes the same task after a blocking response is recorded.

Discover `request_human` with `search_tools`, then invoke it with `execute_tool`.

## Tools Used

- `search_tools` — discover the current human-input contract.
- `execute_tool` — invoke the discovered tool through compact MCP mode.
- `request_human` — create the governed blocking or advisory interaction.
