---
name: linear-code-review-handoff
description: Submit PR review findings to GitHub and deliver a concise actionable verdict to the linked Linear issue through Linear MCP, with a verified agent mention when corrections are needed.
---

# GitHub PR review to Linear issue handoff

## Before submitting

1. Identify the **actual** Linear issue and linked PR from GitHub/Linear, not solely from copied task text.
2. Read the current PR head SHA, submitted review state, inline comments, checks and test evidence. Never invent review findings.
3. Read existing issue comments to avoid duplicate review verdicts for the same PR head.
4. Keep detailed file/line review comments on the GitHub PR (or Linear Reviews, which syncs with GitHub). They are **not guaranteed to become comments on the Linear issue**. GitHub Issues Sync comments are a separate feature.

## Submit review feedback

Post one compact Linear **issue comment** via the connected Linear MCP with:

- Verdict: `CHANGES_REQUESTED`, `APPROVED`, or `BLOCKED`
- Linked PR URL and verified head SHA
- Actionable findings with severity and direct links to inline PR comments
- Tests/evidence and any unresolved acceptance criteria
- Clear next action for the implementing agent

For `CHANGES_REQUESTED`, mention the configured implementation agent (such as Antigravity) using **a real resolvable Linear mention**, not merely a literal `@antigravityagent` string. Verify that the Linear integration actually created an agent session. If mention resolution or MCP write fails, report it as a blocker; don't claim the handoff succeeded. Only mention the agent when follow-up work is needed. Avoid auto-rementioning the agent on each synchronized PR notification.

For `APPROVED`, post the verdict without re-triggering implementation. The agent must not merge or deploy unless the issue explicitly authorizes it.

## Incoming follow-ups

Linear `AgentSessionEvent created` carries `promptContext` for new sessions. `prompted` carries only the follow-up instruction in `agentActivity.content.body`. The Worker forwards that new instruction for the existing agent session, and the bridge saves `sessionAction` in the job. Existing agent runtime session reuse must be verified separately; preserving the Linear session ID does not by itself guarantee restoring a local model's conversational history.

## Safety

Do not invent findings, claim tests passed without evidence, or treat GitHub PR review activity as proof that a Linear issue comment was posted. Do not write tokens, webhook secrets, or sensitive environment data into a Linear comment.
