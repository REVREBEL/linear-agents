# Agent persistence and automated PR-review loop

## Scope and status

This branch implements the first executable increment on top of the existing
LinearBridge job ledger, GitHub App Workers, and ChatGPT Shortcuts handoff.
It does **not** yet implement memU, PostgreSQL, independent review verification,
or dispatching ChatGPT findings back to the coding agent. Do not describe a
Shortcut submission as a completed review.

## State separation

1. **Live Linear job ledger**: authoritative event/delivery processing in
   `linear-jobs/job-state/`, existing in `job-store.mjs`.
2. **Active Linear issue checkpoint**: `linear-jobs/active-task-memory/`,
   keyed by the repository root and Linear issue ID. A follow-up retrieves
   the checkpoint and attaches a bounded, non-authoritative recovery preamble.
   The runner must inspect Git/tests independently. Process exit code 0 is
   recorded as process success, *not* proof that tests passed.
3. **Active PR review checkpoint**: `linear-jobs/github-events/task-memory/`,
   keyed by repository and PR number, storing latest event, classification,
   dispatched change digest, and observed head SHA or comment ID.
4. **Long-term memU** (not wired): verified, reusable architectural decisions,
   defects, test quirks and project conventions; promote only when work is
   independently verified. Preserve original execution ledger after promotion.

All local records have private filesystem modes, use atomic rename, and are
excluded from Git by the existing `linear-jobs/` exclusion. These currently
live wherever the local bridge runs; they are **not** in rebel-server
PostgreSQL until a migration is implemented.

## GitHub event flow

```text
GitHub App (chatgpt/antigravity)
  -> Cloudflare Worker /webhook (HMAC verification)
  -> POST bridge /github/events
  -> sanitize and classify
  -> claim unique semantic change digest
  -> durable event journal + per-PR checkpoint
  -> existing ChatGPT Shortcut handoff for actionable changes
  -> existing callback journal (transport result only)
```

The initial classifier is deterministic and conservative:
- PR opened non-draft and ready-for-review: review request.
- PR synchronized with a new head SHA: review request.
- PR conversation comment reporting a substantive revision with concrete
  evidence: review request, **subject to reviewer verification**.
- Bot comments, linkbacks, generic status comments: journal only.
- Uncertain comments: journal only.

Comment prose is not authoritative. The handoff asks ChatGPT to inspect the
actual current head, unresolved review findings and CI. The operational event
journal never stores raw comment bodies. A semantic classifier can be
added later behind the same `classifyGithubReviewEvent()` contract, with
evaluation fixtures and no LLM-driven side effects.

GitHub Apps must subscribe to `Issue comments` as well as the existing
`Pull requests` events. No additional Worker secret is required if the
existing GitHub App webhook secret is already deployed. The bridge accepts
only the existing authenticated Workers.

## Validation

```bash
npm run typecheck
npm run bridge:test
npm run test:reliability
```

Critical tests cover:
- PR #158 revision comment classified as actionable.
- Routine, bot, unrelated issue comments do not dispatch.
- Re-delivery/edits generate stable or changed semantic digests appropriately.
- Two new instances read the same persistent PR state.
- Active Linear issue checkpoints survive restart and remain isolated by repo.
- Concurrent task-memory updates serialize and leave no incomplete files.

## Required live acceptance test

1. Deploy both Worker versions and restart the bridge from the reviewed commit.
2. Configure `CHATGPT_HANDOFF_MODE=shortcuts` and verify the destination
   route for the repository points to exactly one existing conversation.
3. Redeliver a real signed `issue_comment.created` event for a substantive
   revision. Expect HTTP 202, a classification checkpoint, and one handoff.
4. Redeliver the same webhook and verify no duplicate handoff.
5. Send a routine bot/linkback comment and verify it is journaled, not dispatched.
6. Push a commit and verify `pull_request.synchronize` dispatches appropriately.
7. Verify the Shortcut reported transport completion; separately verify that
   ChatGPT actually reviewed the PR and recorded its conclusions.
8. Restart the bridge and deliver another event, verifying checkpoint continuity.

## Next increments

- Add a verified review-result contract and a controlled reverse dispatch
  to the owning coding agent, routed by repo/issue/agent, with loop counters
  and fail-closed ambiguity handling.
- Replace local active memory with a PostgreSQL-backed store on rebel-server
  when the bridge can reach it; use a separate database or schema and avoid
  unnecessary vector searches for exact task checkpoints.
- Install pgvector and memU, validate embeddings against local Ollama,
  and promote verified reusable findings only after task completion.
- Add further GitHub events (review submitted, review comments, CI checks)
  and a high-confidence semantic classifier with negative-path evaluations.
