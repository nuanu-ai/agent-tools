# Flow item payload & filter reference

## Mutable issue fields (create_issue / bulk_create_issues / update_issue / bulk_update_issues)

| Field              | Type           | Notes                                          |
| ------------------ | -------------- | ---------------------------------------------- |
| `name`             | string         | Title (required on create)                     |
| `description_html` | string         | **HTML**, not markdown                         |
| `priority`         | enum           | `urgent` `high` `medium` `low` `none`          |
| `state_id`         | string \| null | State UUID; `null` resets to project default   |
| `state_name`       | string         | Exact state name (alias for `state_id`)        |
| `assignee_ids`     | string[]       | User UUIDs; `[]` clears                        |
| `assignee_emails`  | string[]       | Exact member emails (alias)                    |
| `assignee_names`   | string[]       | Exact member display names (alias)             |
| `label_ids`        | string[]       | Label UUIDs; `[]` clears                       |
| `label_names`      | string[]       | Exact project label names (alias)              |
| `start_date`       | string \| null | `YYYY-MM-DD`; `null` clears                    |
| `target_date`      | string \| null | `YYYY-MM-DD`; `null` clears                    |
| `parent_id`        | string \| null | Parent issue UUID; `null` detaches             |
| `parent_ref`       | string         | Human parent identifier, e.g. `ENG-10` (alias) |
| `estimate_point`   | string \| null | Estimate point UUID; `null` clears             |

Canonical fields returned by `get_issue` (`state_id`, `assignee_ids`,
`label_ids`, `parent_id`) can be fed back unchanged.

## list_issues filters

| Filter                       | Type                | Notes                                                                    |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `state`                      | uuid \| uuid[]      | (`state_id` = single-value alias)                                        |
| `state_group`                | enum \| enum[]      | `backlog` `unstarted` `started` `completed` `cancelled`                  |
| `priority`                   | enum \| enum[]      | same values as above                                                     |
| `assignees`                  | uuid \| uuid[]      | (`assignee_id` alias)                                                    |
| `labels`                     | uuid \| uuid[]      |                                                                          |
| `created_by`                 | uuid \| uuid[]      |                                                                          |
| `cycle` / `module`           | uuid \| uuid[]      | (`cycle_id` alias)                                                       |
| `parent`                     | uuid \| uuid[]      | direct children of an issue                                              |
| `subscriber`                 | uuid \| uuid[]      |                                                                          |
| `sub_issue`                  | boolean             | include sub-issues when `true`                                           |
| `start_date` / `target_date` | string              | Plane date filter expression, e.g. `2026-01-31;after` (combine with `,`) |
| `order_by`                   | string              | Plane ordering expression, e.g. `-created_at`, `priority`                |
| `cursor` / `per_page`        | string / int ≤ 1000 | pagination                                                               |

## Relation types (create_issue_relation)

`blocking`, `blocked_by`, `duplicate`, `relates_to`,
`start_before`, `start_after`, `finish_before`, `finish_after`

The relation is created from the addressed issue toward one or more
`related_issue_ids`.

## Attachment flows

- **Small text/binary** — `upload_small_issue_attachment` with inline content.
- **Large/binary** — `create_issue_attachment_upload` → HTTP POST the bytes to
  the returned presigned target → `complete_issue_attachment_upload`.

## Project member roles

`5` = guest, `15` = member, `20` = admin (used by `add_project_members`,
`update_project_member`).
