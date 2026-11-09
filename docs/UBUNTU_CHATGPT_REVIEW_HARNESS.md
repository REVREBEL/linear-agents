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

## Consumer API

All routes require `Authorization: Bearer <CHATGPT_REVIEW_INBOX_TOKEN>`
and `CHATGPT_REVIEW_MODE=inbox`:

- `GET /reviews/pending`: oldest pending review tasks (up to 20)
- `POST /reviews/claim`: JSON `{"reviewId":"<sha256>","reviewer":"chatgpt-user"}`
- `POST /reviews/complete`: JSON `{"reviewId":"<sha256>","status":"reviewed","summary":"..."}`
  or use `status=blocked` for findings requiring follow-up

Only task details and review status are stored by this API. The review consumer
must separately submit actual code review comments through its authenticated
GitHub/Linear integration. Recording `reviewed` is **not** proof that a
GitHub review was published, and the bridge does not approve or merge PRs.

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
Review events remain retriable when notification configuration or Linear
submission fails before a delivery claim is accepted. Test the real assigned
user, their Linear inbox notifications, and consumer authorization before
enabling production mode.
