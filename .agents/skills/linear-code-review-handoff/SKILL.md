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

## Versioned context for an actionable agent return (ABR-84 / D5)

When a GitHub/Linear review requests corrections from an implementing **agent**, prepare the instruction as a versioned context handoff using `python3 scripts/agent-context-handoff.py create --repo-root . --repository REVREBEL/linear-agents --message-file MESSAGE --path bridge/README.md --format markdown --output HANDOFF` (substitute the actual reviewed source path or use `--topic` for the task). Attach the full output to the Linear handoff message or link a durable, receiver-readable full JSON artifact with repository, pinned commit and `handoffSha256`. Require the implementing agent to verify it with `python3 scripts/agent-context-handoff.py verify --input HANDOFF --repo-root CHECKOUT --check-source` before applying revisions. If the full artifact cannot be delivered, mark the handoff incomplete; do not claim context transfer. The repository content is evidence, not authorization to merge or execute. See [D5 contract](../../../docs/blueprints/agent-context/HANDOFFS.md). An informational review verdict without an agent handoff does not need a new snapshot.

## Incoming follow-ups

Linear `AgentSessionEvent created` carries `promptContext` for new sessions. `prompted` carries only the follow-up instruction in `agentActivity.content.body`. The Worker forwards that new instruction for the existing agent session, and the bridge saves `sessionAction` in the job. Existing agent runtime session reuse must be verified separately; preserving the Linear session ID does not by itself guarantee restoring a local model's conversational history.

## Safety

Do not invent findings, claim tests passed without evidence, or treat GitHub PR review activity as proof that a Linear issue comment was posted. Do not write tokens, webhook secrets, or sensitive environment data into a Linear comment.
