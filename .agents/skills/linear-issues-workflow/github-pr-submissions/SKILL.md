---
name: github-pr-submissions
description: Prepare, verify, and publish Git branches and GitHub Pull Requests using repository scripts and GithubMCP. Use when local changes are ready to be pushed to remote, verified through repository scripts, and submitted or updated as a GitHub PR.
---

# GitHub PR Submissions

Verify, push, and submit GitHub Pull Requests using target repository scripts and GithubMCP. This skill ensures branch integrity, executes pre-push verification, publishes commits to the remote branch, and creates or updates a structured Pull Request.

## When to Use

- Local implementation or revision is complete and verified.
- An issue branch needs remote publication, CI validation, or GitHub PR creation.
- An existing PR needs an updated HEAD commit pushed for re-review.
- Do NOT use for posting Linear issue comments or updating Linear status (use linear-review-submissions).

## Procedure

1. Commit and Verify Branch
   - Ensure all intended changes are committed with issue-linked commit messages (for example, feat(auth): add token validation [ENG-123]).
   - Prefer the installed local `bash .agents/skills/linear-issues-workflow/scripts/verify-issue-branch.sh <issue-id>` unless an approved repository-specific policy overrides it.
   - Inspect and resolve any verification failures before publishing. Do not force-push or bypass branch safeguards.

2. Push Branch to Remote
   - Prefer the installed local `bash .agents/skills/linear-issues-workflow/scripts/prepare-issue-pr.sh <issue-id>` unless repository policy overrides it.
   - Confirm whether the script creates the PR or only pushes the branch.
   - If no script exists, push the issue branch to the configured remote origin using standard Git commands. Confirm the target PR base branch matches the repository standard (for example, main).

3. Create or Update Pull Request via GithubMCP
   - For new work: Create one Draft PR linking the Linear issue in the title and description.
   - For revisions: Push updates to the existing PR branch. Do NOT open a duplicate PR.
   - Ensure the PR description contains:
     - Clear objective and Linear issue link.
     - Summary of changes implemented.
     - Acceptance criteria checklist with verification evidence.
     - Tests executed with command outputs.
     - Known limitations or open risks.

4. Monitor CI and Automated Review Bots
   - Monitor required CI checks until completion.
   - If automated review bots raise actionable code findings, apply fixes locally and push to the same PR.
   - Do not wait indefinitely for non-blocking or optional bots. Note any pending optional checks in the PR description.

5. Transition PR State
   - Mark the Draft PR as Ready for review once checks pass and implementation is complete.

6. Handoff
   - Transition to linear-review-submissions to notify Linear.

## Gotchas

- Never push directly to protected branches such as main or production.
- Pushing code is not merging. Do not merge the PR into the target branch.
- Never create multiple PRs for the same Linear issue.

## Required end-of-turn step
After finishing this turn's work, whether successful, blocked, informational or failed, **always** execute [`linear-turn-completion`](../linear-turn-completion/SKILL.md) for the current trusted bridge job/session. This is separate from the one-time authorized change of issue status to `Done`.
