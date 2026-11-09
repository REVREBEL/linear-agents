# Suppress self-authored GitHub code-review requests

The bridge can suppress GitHub events authored by ChatGPT's *own verified GitHub actor* before code-review handoff. It still journals the sanitized event and records the classification reason `self-authored-event` in per-PR task memory, retaining existing delivery/change deduplication.

## Configuration

Set these environment variables for the **local bridge process** (not a Cloudflare Worker):

- `GITHUB_CHATGPT_SELF_IDS`: comma-separated GitHub numeric user IDs assigned to ChatGPT's writing identity (recommended).
- `GITHUB_CHATGPT_SELF_LOGINS`: comma-separated exact GitHub logins for the same account(s), case-insensitive. Use only if the identity is confirmed.

**Default: no identities are configured, so self-origin suppression is disabled.** No GitHub account IDs or logins are inferred from the PR author, environment, or other metadata. An operator must explicitly configure verified identity values before suppression can occur. Unset or empty variables both produce empty allowlists. Account IDs/logins are not credentials. Configure them through the running bridge's `.env` (or other service-specific environment) and restart `agent-bridge.service` on Ubuntu, or the configured LaunchAgent on macOS. Do **not** place OAuth access tokens or GitHub App private keys in this configuration.

## Behavior

- `issue_comment`: compares `comment.user.id` and `comment.user.login` because that identity authored the comment, regardless of webhook sender.
- `pull_request` (`opened`, `ready_for_review`, `synchronize`): compares `sender.id` and `sender.login`, the user that triggered the event. **Never** infer the latest push author from `pull_request.user` (the original PR creator).
- Matching self-authored events are recorded but not dispatched, and get `self-authored-event` as classification reason. External actionable events are dispatched through existing rules.
- A GitHub `synchronize` event identifies the event actor, **not** each commit's author. When sender identity is missing or a different actor pushed ChatGPT's commit, the filter conservatively allows normal review. A future authenticated commit-provenance lookup can cover that case.
- This only gates the ChatGPT GitHub **review handoff**. It does not suppress Linear agent completion notifications or authorize an agent follow-up.

## Validation

```bash
node --test linear-agent-bridge/github-events.test.mjs
```

Run both unit and isolated end-to-end `/github/events` dispatch tests. Unset or empty identity variables must preserve an otherwise actionable PR review handoff. A deliberately configured matching GitHub account ID or login must suppress its own event; a different actor must still dispatch. Check the event journal, classification outcome, and handoff file. The Linux integration harness does not require a real Apple Shortcuts installation; it verifies the routing/claim and persisted handoff, not a browser session completing work.

Do not guess an identity from the text `ChatGPT`, commit email, PR creator, or GitHub App delivery header. If the GitHub integration operates using a shared human identity, this filter cannot reliably separate ChatGPT's actions from the human's without additional authenticated provenance, and should remain disabled for that account.
