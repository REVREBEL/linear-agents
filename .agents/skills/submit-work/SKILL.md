---
name: submit-work
description: Finish a Bridge-managed coding assignment using its launcher-provided private submission command.
---

# Submit work

1. Confirm the current issue ID.
2. Add the implementation summary and invoke the launcher-provided command: `submit-work ISSUE-ID "Summary"`.

Done. Bridge verifies the final head, owns publication, requests review and closes the session. For a terminal blocker or failure use the same command with `--blocked` or `--failed` before the issue ID. If the command reports pending or denied, do not repeat external writes or claim submission succeeded.
