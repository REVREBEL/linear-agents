# GitHub webhook ingress and event journal

## Flow

GitHub App webhook → `github-{agent}.revrebel.io/webhook` → Worker HMAC-SHA256 verification → authenticated `POST /github/events` on local bridge → append-only local event journal.

The existing GitHub Workers handle `chatgpt` and `antigravity` only. The Worker needs a configured `GITHUB_WEBHOOK_SECRET` in Cloudflare, matching the GitHub App webhook secret. Workers also need `BRIDGE_SHARED_SECRET`.

Inbound events currently recorded: `ping`, and `pull_request` actions `opened`, `reopened`, `synchronize`, `ready_for_review`, `closed`, `converted_to_draft`, `edited`. Unknown event families/actions are acknowledged and ignored.

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

Pull changes and deploy `linear-chatgpt` and `linear-antigravity` Workers, then restart the local bridge. No Chrome, Shortcuts, or PR-review execution is triggered by this initial ingress milestone. A successful HTTP 202 acknowledges durable journal acceptance, **not** that a review started or completed.

## Next phase

Route only selected pull_request actions to the reviewing agent, map repository/PR to a Linear project and existing ChatGPT conversation, enqueue the macOS Shortcuts handoff, and track browser submission and review completion separately. Keep event journal publishing decoupled from webhook acknowledgement; GitHub push failures should not cause GitHub to resend valid events.
