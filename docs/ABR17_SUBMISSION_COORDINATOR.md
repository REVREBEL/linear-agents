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

## M3 — Verified provider publication and recovery

The coordinator remains disabled by default. M3 adds host-only provider
clients and composition, not a deployed dispatcher integration. All tokens
and private keys are obtained through approved host callbacks, never from
agent inputs. The broker defaults to read-only; its explicitly enabled
publication permission adds only pull_requests:write scoped to the configured
repository ID and verified installation, with no contents write. No Git push,
force-update, merge, or deployment is performed.

The repository's configured agent mapping must include the verified GitHub
bot user ID and the ready/draft policy. GitHub PR history for the exact
branch is queried with state=all; closed, mismatched or ambiguous history
is refused rather than replaced. An existing open PR must have the issue
marker, configured bot author, pinned repository/head/base and original
PR number for a revision. A new PR records its initial verified head.
Revisions use the same PR (the existing pre-pushed branch advances it),
with new evidence in Linear and the canonical review inbox. All configured
checks are independently read at publication and again before downstream
mutations. A draft is an intentional external effect; the outbox remains
pending at github_published until an explicitly authorized operator marks
the PR ready and the read-only recovery verifies it. M3 does not
automatically convert drafts or wait for PR-only CI. M1's pre-pushed,
pre-verified-check policy is retained.

Linear uses a fixed GraphQL endpoint, a private token loader, and explicit
tenant/organization, agent app user, exact team and workflow state mapping.
Comment publication includes the PR, exact submitted head, configured
verified-check status, sanitized descriptive summary and deterministic
operation marker. Verify the saved comment and author using a bounded full
connection; a missing, duplicate or conflicting result is not proof.
Transition only to the configured started-type In Review state in the
same team. Independently read back the actual state. A missing or ambiguous
review routing destination prevents publication. The existing durable
ChatGPT user-review inbox receives the canonical ready_for_review event;
queued does not imply reviewer notification or acknowledgment. ABR-18 must
reconcile webhook and coordinator event deduplication across event types.

Worker completion uses the mapped HTTPS /complete endpoint, the actual
existing agentSessionId/organizationId/status/activityType/body contract,
and never forwards the Worker secret to an agent. Before writing, read
the scoped Linear session and require the expected issue and app user.
Completed status requires In Review and the verified review inbox.
Then independently query Linear AgentSession activities, verifying
the exact operation marker, content type, author, archived/ephemeral/signal
state, session status and latest activity. Worker request statuses are
completed/failed, whereas Linear session statuses are complete/error.
A transport acknowledgment is not a verified completed session. Source:
https://linear.app/developers/agent-interaction and
https://linear.app/developers/agent-best-practices (Agent Session lifecycle,
Agent Activity union, activity queries); the existing shared Worker
delivery-coordinator contract owns /complete routing.

An explicit trusted failure or blocked submission is a distinct
received → failed/blocked journal path: terminal error activity only, no
GitHub publication, In Review or reviewer queue. It cannot overwrite a
successful or uncertain submission. Known terminal failure retries are
read-only; pending ambiguous failure effects require independent observation.
Existing runner integration must supply this explicit outcome, not infer it
from an agent's prose or provider timeout. Recovery requires trusted
operator/host approval and only performs reads of the pending operation.
No automatic replay, no second task authority.

### Actual evidence and remaining gates

M3 tests run real source clients using fixed provider URLs and injected
fixture transport, test-only RSA keys, actual canonical ledger, SQLite
outbox and review inbox. The direct Linear read-back contract is tested
with provider-shaped fixture responses; credentials, installed app
permissions, GraphQL schema/actor compatibility and production behavior
are not verified by these fixtures. M2 covers actual confined Git reads.
Missing/changed live evidence remains pending or denied, not fabricated
success. M4 must wire the authenticated dispatcher and provider finish paths,
including explicit failure handling, canonical ledger fields, trusted
credential source, ABR-99 coordinator binding, and the minimized common
skill. M5 must independently verify actual permissions, Linux/Mac policy,
approved staging issue and real provider lifecycle before enabling.
