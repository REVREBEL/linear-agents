---
name: linear-issue-closeout
description: Final authorized Linear issue status closeout after review approval and verified completion; used only once when moving an issue from In Review to Done. This does not replace per-turn bridge completion.
---

# Linear Issue Closeout

## When to use
Only after explicit authorization to close the issue and verified satisfaction of its specific acceptance criteria and required review or merge conditions. Do not use for routine agent turns, comments, review submissions, blocked work, or mere completion of a PR draft.

## Procedure
1. Verify authorized closeout decision and current Linear issue status; confirm the reviewed PR, merge state and actual final commit when the issue requires a merge. Non-code issues may have other authorized review evidence.
2. Record final evidence and decision in Linear; avoid inventing a merge commit or a GitHub PR for a non-code issue.
3. Change the issue from `In Review` to `Done` once, using the authorized Linear MCP, then read back and confirm.
4. Run `../linear-turn-completion/SKILL.md` for **this closeout turn**. This webhook is required even though the issue is now Done.

## Never
Never set Done merely because a bridge turn succeeded or a PR was submitted. Do not skip per-turn bridge completion, and do not send the final webhook as a substitute for updating Linear.
