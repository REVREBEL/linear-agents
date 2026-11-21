# ABR-17 M1 — Bridge-owned Submission Coordinator

**Reviewable milestone, disabled by default.** The final agent UX remains
`submit-work ABR-17 "Summary of implemented work"`. M1 establishes the
coordinator and durable effect contract, not that installed runner command.

## Authority and ownership

The existing canonical job ledger remains the only job authority. The
coordinator requires independently verified admission, a live job matching
tenant, coding agent, issue UUID/identifier, session, host, repository/root,
branch/base, mapped GitHub App/installation identifiers, submission cycle and
expected SHA. A private handle is minted only from that admitted scope.
Caller inputs contain issue confirmation and bounded redacted summary only.
No caller-selected credentials, SHA, PR number, URL or workflow state.

A SQLite transactional effect journal sits in the existing authoritative
job-state directory, not on both Mac and Ubuntu and not in the code workspace.
Unique issue ownership prevents overlapping publication attempts, while an
issue/head constraint prevents duplicate revisions. The record preserves the
previous PR for a later authorized new head under the same publication
scope; changing repository, branch, base or installation fails closed.

## Source state machine

received → validated → git_ready → github_published → linear_posted →
in_review → review_queued → session_closed

Every step records its pending intent durably before invoking a trusted
adapter. The preflight policy is **already committed, clean, pre-pushed
branch, exact matching remote SHA and verified required checks**. M1 never
stages, commits, pushes or bypasses CI. Real Draft PR management and
preflight readiness policy remain in the publication adapter milestone.

Each external receipt is reduced to approved fields and checked against
the pinned admitted scope. PR numbers are verified with exact repository,
head/base and app/installation; a revision must reuse the previous PR.
The successful workflow state is In Review; a review queue receipt is
not reviewer ACK. Worker completion must say completed (not complete).
The coordinator never marks the issue Done, merges, or clears the inbox.

An ambiguous or invalid response leaves the exact pending intent intact.
Retries return reconciliation_required, not a duplicate external write.
An explicit trusted recovery verifier may affirm the exact operation ID
and observed receipt; revalidate the current job and persist that receipt
before later steps can proceed. If the canonical job is already interrupted
or scope has changed, fail closed pending the reviewed recovery admission
flow. The first milestone does not provide a tenant-controlled retry/reset,
nor a terminal failed/blocked Worker adapter.

## Verified and outstanding

M1 tests are actual file-backed job and SQLite journal tests with exclusively
injected external-effect fixtures. They do not authenticate to GitHub or
Linear, and do not verify a real app installation. Existing provider dispatch
currently exposes credentials through legacy runner contracts; these must
be replaced with a narrowly scoped launcher-owned capability before live
submission. Do not expose GitHub App keys/JWT/install tokens, Linear OAuth
or Bridge shared credentials to agents.

- M2: authenticated local ingress and per-runner scoped capability, authoritative
  ledger enrichment, real read-only Git preflight and GitHub credential broker;
  inspect mapped app installations and permissions through trusted host configuration.
- M3: real GitHub/Linear/Worker adapters with independent verification and
  recovery, Draft/Ready distinction, explicit blocked/failed session handling.
- M4: AGY/Trae/OpenCode finish integrations, minimal provider-neutral skill and
  dedicated AGY workflow; ABR-99 integration must share the same coordinator.
- M5: independently authorized actual staging, security review, deployment and
  rollback proof. ABR-18 owns actual reviewer notification and ACK.

## Rollback

No runtime import, listener, credential use or service activation is introduced.
Keep the feature disabled; retain pending effect records for forensic
reconciliation. Never remove the existing job ledger, blindly repeat a
publication, close a session twice or delete the task inbox.
