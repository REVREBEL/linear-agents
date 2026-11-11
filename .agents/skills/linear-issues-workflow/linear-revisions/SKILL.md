---
name: linear-revisions
description: Handle code review comments, requested changes, and follow-up feedback on existing Linear issues and pull requests. Use when an issue receives review changes requested, a comment mentions the agent, or corrections are required on an existing branch and PR.
---

# Linear Revisions

Process reviewer comments and revision requests for existing Linear issues and open pull requests. This skill reuses existing issue branches and PRs, verifies feedback against current HEAD, applies scoped corrections, and verifies test results before submission.

## When to Use

- Linear bridge delivers an actionable review comment or "Changes requested" event.
- Follow-up corrections or additional evidence are requested for an active PR.
- Do NOT use for initial assignments or new issues (use linear-new-issues).

## Procedure

1. Triage Feedback and Verify Scope
   - Confirm the comment is a genuine agent handoff and not quoted text from prior messages.
   - Retrieve the reviewed commit SHA, PR URL, and existing review threads.
   - Compare the feedback against the current remote branch HEAD. If the feedback targets outdated code, identify what has changed before editing.
   - If the request requires out-of-scope changes, destructive database modifications, or production deployments, post a question requesting authorization.

2. Prepare Existing Workspace and Branch
   - Checkout the existing issue branch. Do NOT run new branch creation scripts.
   - Ensure the working tree is clean and aligned with the existing PR branch.
   - Move the Linear issue status to In Progress.

3. Implement Corrections
   - Address valid reviewer findings directly in code.
   - If a reviewer only requested clarification or evidence, gather the evidence without fabricating empty code commits.
   - Respond directly to specific GitHub review comments explaining changes made with supporting technical rationale.

4. Validate Locally
   - Rerun affected unit tests, integration tests, linters, and type checkers.
   - Record exact test commands, passing counts, and any remaining warnings.
   - Ensure no regressions were introduced.

5. Handoff
   - Once corrections are verified locally, transition to github-pr-submissions and then linear-review-submissions.

## Gotchas

- Do not create a new branch or open a second PR for review revisions. Always reuse the active branch and PR.
- Do not dismiss reviewer findings merely to clear review flags without technical justification.
- Avoid repeating new-work initialization steps on a revision.

## Required end-of-turn step
After finishing this turn's work, whether successful, blocked, informational or failed, **always** execute [`linear-turn-completion`](../linear-turn-completion/SKILL.md) for the current trusted bridge job/session. This is separate from the one-time authorized change of issue status to `Done`.
