# Suppress self-authored GitHub code-review requests

The bridge can suppress GitHub events authored by ChatGPT's *own verified GitHub actor* before code-review handoff. It still journals the event, including the classification reason `self-authored-event`, and retains existing delivery/change deduplication.

## Configuration

Set these environment variables for the **local bridge process** (not a Cloudflare Worker):

- `GITHUB_CHATGPT_SELF_IDS`: comma-separated GitHub numeric user IDs assigned to ChatGPT's writing identity (recommended).
- `GITHUB_CHATGPT_SELF_LOGINS`: comma-separated exact GitHub logins for the same account(s), case-insensitive. Use only if the identity is confirmed.

Both are optional and disabled when empty, to prevent accidentally hiding an external review. Account IDs/logins are not credentials. Configure them through the existing bridge environment/LaunchAgent, then restart the bridge as usual. Do **not** place OAuth access tokens or GitHub App private keys in this configuration.

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

Validate one self-authored comment and PR synchronize delivery, then an externally authored revision on the same PR. Check the event journal and classification outcome; the external actionable event must still produce one handoff.

Do not guess an identity from the text `ChatGPT`, commit email, PR creator, or GitHub App delivery header. If the GitHub integration operates using a shared human identity, this filter cannot reliably separate ChatGPT's actions from the human's without additional authenticated provenance, and should remain disabled for that account.
