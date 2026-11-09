# ChatGPT user PR review harness on Ubuntu

This is a separate execution and delivery path from the **ChatGPT CLI** Linear
agent. The CLI receives coding assignments and posts Agent Activities to its
own Worker. The **ChatGPT user** receives GitHub review requests in a durable
review inbox and, if configured, as a separate Linear issue assigned to the
designated user.

## Event flow

```
GitHub PR / substantive revision
   → existing GitHub event publisher and classifier
   → Ubuntu bridge POST /github/events
   → verified PR-to-Linear project codeReview mapping
   → durable review-inbox/<semantic-change-id>.json
   → optional Linear issue assigned to ChatGPT user
   → ChatGPT user reviews PR using GitHub/Linear connectors
   → authenticated review consumer claims/records outcome
```

The bridge only queues events classified as actionable: review-ready PRs,
new commits on non-draft PRs, or substantiated human revision reports. Its
existing self-origin and bot/noise suppression still apply. Duplicate events
from different GitHub Apps converge on the same semantic key. Stored review
prompts instruct the reviewer to inspect the current diff, checks, and
unresolved feedback, not trust the webhook report as verification.

## Required configuration

Configure the approved repository mappings in ignored
`linear-agent-bridge/routing.json` with `codeReview.provider=chatgpt`,
`conversationMode=reuse-existing`, `autoSend=true`, and an existing
ChatGPT Project conversation URL. This is a **review destination reference**,
not an automatic browser submit.

In the Ubuntu service's trusted environment:

```sh
CHATGPT_REVIEW_MODE=inbox
CHATGPT_REVIEW_INBOX_TOKEN=<long-independent-32-character-minimum-secret>
```

To additionally generate a **Linear review issue assigned to the user**:

```sh
CHATGPT_REVIEW_NOTIFY_MODE=linear-user
CHATGPT_REVIEW_LINEAR_TEAM_ID=<verified-Linear-team-UUID>
CHATGPT_REVIEW_LINEAR_USER_ID=<verified-ChatGPT-user-UUID>
# LINEAR_API_KEY must already be present with permission to create/edit issues.
```

The configured reviewer must be a Linear **user**, not the ChatGPT CLI
**agent app**. Never reuse ChatGPT CLI OAuth credentials, agent-session IDs,
or `CHATGPT_CLI_LINEAR_API_KEY` for this notification. Do not use made-up
UUIDs or paste production API keys into GitHub.

One stable Linear issue is created per `repository#PR` and assigned to the
configured user. Later actionable events update the same issue instead of
creating a new issue for every commit. The issue contains the PR link, most
recent event context, and review-inbox ID. The fixed per-PR issue ID makes
retries after network uncertainty idempotent. A Linear issue update may not
generate a fresh notification on every revision; do not confuse it with
verified delivery to ChatGPT's conversation UI.

## Initial message delivery to the existing ChatGPT conversation

Set `CHATGPT_REVIEW_SEND_MODE=mac-ssh` on Ubuntu to enable the **initial
message only**. The already-configured `codeReview.conversationUrl` is used;
no new ChatGPT review consumer, CLI identity, GitHub integration, or review
workflow is created. Ubuntu sends the review prompt by SSH stdin to a fixed
Mac runner. By default that runner invokes the **existing Playwright controller**
with `--auto-send` to fill the intended conversation's composer and attempt Enter.
ChatGPT then handles the PR using its existing GitHub and Linear tools.

Requirements: `MAC_SSH_HOST`, `OSX_PROJECTS_ROOT`, optionally `MAC_NODE_BIN`
and `MAC_REVIEW_RUNNER_PATH`. The default review runner is
`<OSX_PROJECTS_ROOT>/linear-agents/scripts/macos/chatgpt-shortcuts/review-handoff.mjs`.
Both hosts must have the updated branch; the Mac requires SSH key trust,
the installed `scripts/chatgpt-playwright` dependencies, and an authenticated
dedicated Chrome/CDP profile accessible to the SSH user. The controller needs
the existing GUI browser session and must not expose its CDP port externally.
The older Shortcut is only an opt-in fallback via
`CHATGPT_REVIEW_MAC_CONTROLLER=shortcuts`; its documented open-and-copy flow
does **not** establish that a message was submitted. In that mode the runner
returns `HANDOFF_PREPARED`, which Ubuntu intentionally does not accept as
`HANDOFF_ATTEMPTED`.

The event request waits for the remote Playwright process to exit and return
`HANDOFF_ATTEMPTED:<reviewId>` (180-second maximum). This is an **attempted
submission**, not proof that ChatGPT received the message or completed the review.
The inbox records `messageHandoff.state=attempted` separately from the review
state, which remains `pending`. A duplicate semantic event does not re-send
the same initial message. If the SSH session times out or fails, the ledger
records an `uncertain` result; it fails closed instead of automatically
resubmitting, because the original message may have reached ChatGPT.
Inspect the intended ChatGPT conversation before manually retrying.

This path uses the existing macOS Playwright controller. It does not require a new
Cloudflare Tunnel, a ChatGPT message API, or a Mac HTTP listener. The optional
Linear-user issue notification can remain enabled independently.

## Consumer API

All routes require `Authorization: Bearer <CHATGPT_REVIEW_INBOX_TOKEN>`
and `CHATGPT_REVIEW_MODE=inbox`:

- `GET /reviews/pending`: oldest pending review tasks (up to 20)
- `POST /reviews/claim`: JSON `{"reviewId":"<sha256>","reviewer":"chatgpt-user"}`
- `POST /reviews/complete`: a published review requires JSON
  `{"reviewId":"<sha256>","status":"reviewed","summary":"...","githubReviewId":123456}`.
  The bridge fetches the PR and submitted review directly from GitHub before accepting:
  the configured reviewer login, current PR head and review commit must match.
  A GitHub draft review, stale head, other author or made-up review ID is rejected.
  Use `status=blocked` with a summary when the review has not been published;
  blocked never asserts GitHub delivery.

Configure `CHATGPT_REVIEW_GITHUB_TOKEN` as a read-only GitHub token with
pull-request read access to the permitted repositories, and
`CHATGPT_REVIEW_GITHUB_LOGIN` as the exact GitHub account expected to publish
reviews. Keep this token separate from the inbox bearer token and from the
ChatGPT CLI coding credentials. The bridge stores the verified published review
ID, URL, author, state and commit as delivery evidence. A successful GitHub
review is a prerequisite for `reviewed`, not an effect of the completion API.

The review consumer must still publish a GitHub review via its authenticated
GitHub integration; merely invoking this endpoint does not publish anything.
The bridge does not approve or merge PRs, and no automatic ChatGPT conversation
wake-up or unattended review executor is included in this milestone.

## Limits and deployment gate

**This does not autonomously wake a ChatGPT user conversation.** Linear's
assigned issue is a real user-facing work item, while the inbox is a secure
pull interface for a future connected ChatGPT review consumer. There is no
supported ChatGPT message-injection capability in this repository. Do not
report `reviewDispatched=true` for the inbox path; the webhook response uses
`reviewQueued=true`, and `reviewNotified=true` only after Linear
acknowledges the optional assigned issue.

Tunnel/WAF policies must protect the review routes when exposed beyond
localhost. They are not publicly anonymous; use a separately rotated
long token and avoid placing it in URLs, PR descriptions, or browser history.
The opt-in zone WAF Terraform ruleset restricts `/reviews/pending` to GET and\n`/reviews/claim` and `/reviews/complete` to POST on the existing\n`chatgpt-agent.<DOMAIN>` Tunnel host. This WAF rule is not applied by this PR.\n\nReview events remain retriable when notification configuration or Linear
submission fails before a delivery claim is accepted. Test the real assigned
user, their Linear inbox notifications, and consumer authorization before
enabling production mode.
