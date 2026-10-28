# Agent implementation and review issue template

## Current review workflow and routing (2026-10-28)

The canonical code review handoff procedure is [`linear-code-review-handoff/SKILL.md`](../.agents/skills/linear-code-review-handoff/SKILL.md). Review the linked GitHub PR head, checks, inline comments, issue context and acceptance criteria; post a concise Linear issue verdict of **`CHANGES_REQUESTED`**, **`APPROVED`**, or **`BLOCKED`** with verified PR URL, head SHA, evidence, and next action. For corrections, make a resolvable Linear mention of the implementing agent, and verify delivery instead of relying on literal `@text`. Approval alone does not authorize a merge or deployment.

A **Linear Project** with an explicit repository mapping in the bridge's ignored `routing.json` is required for dispatch. An **Initiative is optional** for a standalone mapped project. Do not infer repository paths from issue titles or require an initiative solely to dispatch a mapped standalone project. Populate dynamic session, project, issue, and PR metadata from actual Linear/GitHub records.

---


> Create this as a native Linear **issue template** using Linear Settings → Templates → New issue template. Set the **Project** as an issue property, not only as text. An issue must belong to a mapped Linear project; initiative is optional when the project has an explicit `repository` in `routing.json`.

## Objective

Describe the desired outcome and why it matters.

## Scope

Specify the areas, packages, files or services in scope and any exclusions.

## Requirements

- [ ] Implement the described behavior without unintended regressions.
- [ ] Run applicable tests and checks.
- [ ] Report tests executed, results, and known limitations.
- [ ] Include evidence for each acceptance criterion.

## Acceptance Criteria

- [ ] [Observable criterion 1, include how it will be verified]
- [ ] [Observable criterion 2, include how it will be verified]

## Implementation Notes

Provide dependencies, constraints, relevant documentation, and related issues.

## Agent Submission

*Completed by the implementing agent before requesting review.*

- **GitHub PR:**
- **Head commit SHA:**
- **Implementation summary:**
- **Tests and results:**
- **Known issues:**
- **Review status:** READY_FOR_REVIEW

## Review Handoff

The implementing agent must provide evidence against every acceptance criterion and link the actual pull request and head SHA. ChatGPT should inspect the PR and issue, publish a review verdict through Linear MCP, and mention the implementation agent using a real Linear mention when follow-up is required.

## Required issue properties (configure in Linear's template UI)

- **Team**: choose the correct Linear team
- **Project**: REQUIRED, use a project with a configured repository mapping
- **Delegate**: optional; select the implementation agent to trigger immediately, or leave blank for a later genuine mention
- **Initiative**: not required for standalone projects
- **Status/priority/labels**: choose workflow defaults, not bridge routing parameters

## Dynamic metadata: never pre-fill static or guessed values

The dispatch payload should supply Linear issue ID/identifier, project ID, status, and agent session ID from Linear, plus the verified repository path from the bridge registry. Pull request URL and head SHA should be resolved from linked GitHub evidence once a PR exists; leave unknown values null. Prior review verdict should be read from existing Linear comments at review time, never assumed. Do not overwrite the agent's actual submission with inferred values.
