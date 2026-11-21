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

## M2 — Private runner ingress and verification boundary

M2 builds on the reviewed M1 branch rather than replacing the canonical ledger
or creating a second server. It is disabled by default and requires trusted
launcher and runner verifiers. The launcher produces an explicit, immutable
scope (including the independently confirmed final commit SHA) from admitted
routing and worktree metadata. `submissionLedgerFields` converts that scope to
canonical job metadata for the existing dispatcher; it does not mutate a
ledger or trust issue text. The current runtime must be adapted in M4 to
populate these fields and supply authenticated local/remote runner provenance.

### Private command transport

The launcher hands the command a private duplex FD 3; the command accepts only
the issue identifier and summary, using bounded JSON framing. The trusted
channel handler carries the scoped capability and peer evidence on its own side.
A SHA-256 of an ephemeral per-job random capability is held in memory; expiry,
launcher authorization, runner verification, and exact current ledger scope
are required. The M1 coordinator receives the ingress admission verifier and
liveness predicate together, so revoking the channel also stops new submission
effects. A lost response does not replay a pending M1 intent. No generic public
socket, arbitrary listener, caller-supplied peer identity, or shared-secret
fallback is installed. The actual child process uses no API token in argv or env.
Same-UID peer isolation and secure remote Mac runner transport require the
reviewed production launcher in M4; the Unix socket server in tests is disposable.

### Git and GitHub preflight

The existing ABR-96 sandbox performs real Git inspection of an explicitly
approved canonical root, requiring an exact branch and head, clean tracked and
untracked status, no in-progress merge/rebase/etc., approved GitHub origin,
matching remote head, distinct existing base, and every explicitly configured
required CI check. Required checks are named and bound to an issuing GitHub
App ID; unverified, ambiguous, incomplete or non-successful checks fail closed.
No shell command from the caller, network-enabled Git, commit, push or file
mutation is performed. The test covers an ordinary fixture checkout inside
Linux Bubblewrap. External .git metadata (linked worktrees), macOS sandbox
support, real bridge-UID namespace confinement and final pre-publication
revalidation are still required before operational use.

The host-only broker accepts explicit operator-provided mappings, never guesses
the first installation. It validates app and repository installation with a
short-lived RSA-signed JWT, uses a repository-ID-scoped read-only token with
explicit contents, PRs, checks, statuses and metadata permissions, verifies
the returned repository/permission/expiry scope, caches and refreshes
privately, and exposes only narrow read methods. Current legacy Trae helper
can return an installation token and pick the first installation; it is not
used by this path. Existing source configuration does not establish complete
operator-approved mappings. The actual installed app IDs, repository IDs,
installation permissions/API response compatibility and approved key provider
must be verified by the owner before any live activation. The fixture checks
JWT signatures and token narrowing without loading a real key or reaching GitHub.

M3 will add real scoped publication authority, actual PR/head/base and CI
revalidation at the mutation boundary, Linear and Worker adapters, and
independent recovery. M4 must integrate the existing dispatcher/runner
transport and remove credential exposure in legacy provider contracts.
