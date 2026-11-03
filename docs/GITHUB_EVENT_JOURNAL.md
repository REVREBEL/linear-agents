# GitHub webhook ingress and event journal

## Flow

GitHub App webhook → `github-{agent}.revrebel.io/webhook` → Worker HMAC-SHA256 verification → authenticated `POST /github/events` on local bridge → append-only local event journal.

The existing GitHub Workers handle `chatgpt` and `antigravity` only. The Worker needs a configured `GITHUB_WEBHOOK_SECRET` in Cloudflare, matching the GitHub App webhook secret. Workers also need `BRIDGE_SHARED_SECRET`.

### Secret deployment

The existing `.env` variables are the source of the GitHub webhook signing secrets. `scripts/with-env.sh` maps each agent's `*_GITHUB_SECRET` to Cloudflare's `GITHUB_WEBHOOK_SECRET` binding during `wrangler secret put` after Worker deployment, and into temporary `.dev.vars` for `wrangler dev`. Do not add these secrets to public `wrangler.jsonc` `vars` bindings.

```dotenv
CHATGPT_GITHUB_SECRET="the-GitHub-App-webhook-secret"
ANTIGRAVITY_GITHUB_SECRET="the-GitHub-App-webhook-secret"
```

The value must **exactly match the GitHub App's webhook secret** used to sign the `X-Hub-Signature-256` header. The GitHub OAuth client secret, if separately configured, is not interchangeable. No additional `*_GITHUB_WEBHOOK_SECRET` variables are required. Agents without a populated GitHub secret may still deploy; existing Cloudflare secrets are not deleted when a value is absent.

After deploying, verify with `wrangler secret list --name linear-chatgpt-agent` (names only), then redeliver the failed event in GitHub App Settings → Advanced → Recent Deliveries. HTTP 202 indicates the Worker and bridge accepted the event, not that a review completed.

Inbound events recorded are `ping`, and `pull_request` actions `opened`, `reopened`, `synchronize`, `ready_for_review`, `closed`, `converted_to_draft`, `edited`. Unknown event families/actions are acknowledged and ignored. For the ChatGPT GitHub source, a non-draft `opened` event or `ready_for_review` event also dispatches the configured macOS Shortcut when the repository has exactly one distinct automatic ChatGPT code-review conversation across its mapped Linear projects.

The bridge requires `Authorization: Bearer <BRIDGE_SHARED_SECRET>` and `x-github-agent`. The local endpoint is **not** a public, unauthenticated webhook.

## Local history

The bridge records sanitized metadata at `linear-agent-bridge/linear-jobs/github-events/events.jsonl` (excluded from Git). Deduplication claims are kept in the same directory. It stores only event timestamps, source agent, GitHub delivery ID, event/action, repository, PR number/URL/head SHA/draft and installation ID when present. It does **not** persist the original webhook payload or HMAC signature. Do not commit private issue prompts or job payloads.

## Publish to GitHub

By default nothing is pushed. To publish manually:

```sh
node scripts/publish-github-events.mjs
```

The publisher reads the local journal, clones the repository's `origin` into an isolated temporary directory, merges journal entries by `source:delivery` and pushes only `operations/github-events/YYYY-MM-DD.jsonl` to `main`. This avoids committing unrelated changes in the main checkout. It requires unattended Git credentials if used under launchd; SSH is recommended. Override with `GITHUB_EVENT_PUBLISH_REMOTE` and `GITHUB_EVENT_PUBLISH_BRANCH` if desired. **The GitHub repository is public; do not publish sensitive data.** A dedicated private audit repository is preferable if future log fields contain nonpublic business details.

To publish every 15 minutes on macOS:

```sh
bash scripts/macos/install-github-event-publisher.sh
```

This explicitly installs and starts the LaunchAgent. Confirm Git authentication works without prompts and check `~/Library/Logs/linearbridge-github-events*.log`. To stop the publisher: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.revrebel.linearbridge.github-event-publisher.plist`.

## Deployment

Pull changes and deploy `linear-chatgpt` and `linear-antigravity` Workers, then restart the local bridge. With `CHATGPT_HANDOFF_MODE=shortcuts`, an actionable ChatGPT PR event writes a private handoff file and queues `Linear ChatGPT Handoff`. The bridge response reports `reviewDispatched: true` and the handoff ID. This confirms local dispatch only, **not** that ChatGPT submitted or completed the review; the Shortcut callback is tracked separately.

## Dispatch and deduplication

GitHub delivery claims remain the duplicate-submission boundary: the bridge prepares the handoff before journaling, removes the claim if preparation or journaling fails, and never launches a second Shortcut for the same accepted `source:delivery`. Journal publishing remains decoupled from webhook acknowledgement; GitHub push failures do not cause GitHub to resend valid events.

## ChatGPT PR-review handoff contract (planned dispatcher)

The intended review sequence is: agent opens a GitHub PR → GitHub webhook → verified Worker → local bridge event journal → PR-to-project/conversation lookup → macOS Shortcut → existing ChatGPT conversation. ChatGPT will use its existing context, GitHub integration, and Linear MCP for the review and follow-up. A brief PR reference in the prompt is enough; the bridge does not need to include full issue history.

The ChatGPT Shortcut consumes exactly `conversationUrl`, `prompt`, and `handoffId` in the handoff JSON file. Its GET callback is a plain localhost URL, for example:

```text
http://127.0.0.1:8788/github/handoff-result&handoffid=550e8400-e29b-41d4-a716-446655440000?success
```

Use `?cancelled` or `?error` for other outcomes. See [ChatGPT Apple Shortcuts handoff](CHATGPT_SHORTCUTS_HANDOFF.md) for the full contract and working setup.

**Implementation status:** incoming PR events are authenticated, deduplicated, and journaled. They **do not yet trigger Shortcuts**. The existing Shortcut handoff-file generator is used for ChatGPT jobs arriving through Linear. Shortcut callbacks are logged separately and are not yet reconciled against a GitHub PR-review job. Do not infer that a PR was reviewed merely because a webhook was accepted or a Shortcut returned success.
