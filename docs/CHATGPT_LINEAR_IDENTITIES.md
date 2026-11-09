# Two ChatGPT identities in LinearBridge

Do **not** route these through the same Linear Worker or conversation history.

| Contract | ChatGPT CLI (Linear agent app) | ChatGPT (Linear user / code-review harness) |
| --- | --- | --- |
| Trigger | A coding issue assigned to **ChatGPT CLI** | A PR review request, actionable GitHub event, or review follow-up |
| Host | `chatgpt-cli-agent.<DOMAIN>` (Tunnel) → Ubuntu bridge | Existing `chatgpt-agent.<DOMAIN>` (legacy agent) and GitHub event channel; review-user dispatch is distinct |
| Worker | Dedicated `linear-chatgpt-cli-worker/` with independent OAuth registration, KV and Durable Object | Existing ChatGPT/PR review integration is preserved |
| Execution | Headless OpenCode with the already connected OpenAI/ChatGPT OAuth | **Review inbox + optional Linear-user notification**, not the coding CLI worker |
| Session | New OpenCode session on `created`; reuse verified session for the same Linear `prompted` follow-up | Review context scoped by repository and PR, not coding issue session |
| Response | `/complete` on the **CLI Worker's** domain, using its Linear Agent Session ID | Review report belongs to the review surface, not the coding agent's Agent Session |
| Credentials | `CHATGPT_CLI_LINEAR_*` and dedicated app installation | Separate ChatGPT user identity and existing GitHub review identity |

This PR splits the coding-side identity and adds OpenCode progress activities. It
**does not** silently convert the existing Linear ChatGPT user into an agent,
nor assume a user can receive an `agentActivityCreate` message. The PR review harness now queues actionable GitHub events in an authenticated\nuser review inbox. Optional Linear review issues can be assigned to a verified\nChatGPT user via `CHATGPT_REVIEW_NOTIFY_MODE=linear-user`. This is not a\nChatGPT conversation wake-up; see `docs/UBUNTU_CHATGPT_REVIEW_HARNESS.md`.

## Register the separate Linear app

Create/verify the *ChatGPT CLI* Linear OAuth app independently of the existing
ChatGPT user / review integration. The CLI app must have its **own** client ID,
client secret, webhook HMAC secret, KV namespace, and Worker custom domain.
Use `read,write,app:assignable,app:mentionable` and register the matching
`https://linear-chatgpt-cli.<DOMAIN>/oauth/callback` and
`https://linear-chatgpt-cli.<DOMAIN>/webhook` URLs. No IDs or secrets are
hardcoded in the repository. The existing app's OAuth installation must not
be reused for the CLI identity.

The Tunnel hostname `chatgpt-cli-agent.<DOMAIN>` must forward `/jobs` to the
**same Ubuntu listener** at `127.0.0.1:8788`, preserving the host header.
This is infrastructure setup: this repository's Terraform does not own Tunnel
ingress, so deploying the Worker alone is not enough. Enable the new CLI Worker
only when DNS, Tunnel, OAuth credentials and WAF allowlist are configured.

In the trusted Ubuntu `.env`, configure `CHATGPT_CLI_PREFIX`,
`CHATGPT_CLI_HOST`, `CHATGPT_CLI_KV_NAMESPACE_ID`,
`CHATGPT_CLI_LINEAR_CLIENT_ID`, `CHATGPT_CLI_LINEAR_CLIENT_SECRET`,
`CHATGPT_CLI_LINEAR_WEBHOOK_SECRET`, `OPENCODE_BIN`,
`CHATGPT_OPENCODE_MODEL`, and optionally `CHATGPT_OPENCODE_USER`.
See `.env.example` for the variable names.

## Coding progress and response

Ubuntu receives coding job metadata through the ChatGPT CLI Worker, creates
a new OpenCode run for an initial assignment, and stores the resulting
`ses_...` ID under an agent-specific ledger key. Same-Linear-session
follow-ups reuse that session. Progress is reduced to a fixed set of generic
activity messages; raw tool input/output, arguments, reasoning, and secrets
are not sent to Linear. The Worker receives `thought` activities during
execution and a terminal `response` or `error` via its authenticated
`/complete` route. Only a confirmed final callback marks the job complete.

`opencode run --format json` being available is not proof that the stored
ChatGPT OAuth credentials or configured model are usable. A real assigned test
issue is required before production cutover.

## Review harness boundary

The existing GitHub event classifier, self-origin suppression, and PR memory
continue to classify review events. The legacy Mac Shortcuts path is not
silently rerouted to ChatGPT CLI. For Ubuntu, a distinct read-only review
harness and delivery/notification contract are still required. Review output
must never be posted into the CLI coding agent session.

