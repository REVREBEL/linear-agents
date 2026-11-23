# Ingress handler owners

Canonical modules: `diagnostic-routes.mjs`, `review-routes.mjs`, `github-webhook-routes.mjs`, `trae-callback-routes.mjs`, `issue-completion-route.mjs`. Every handler keeps its existing authentication and callback contract. Compose them through `../server/http-route-composition.mjs`, never create an additional server or duplicate dispatch state.

## ABR-17 M2 — Private submission channel

`submission-channel.mjs` handles one bounded newline-delimited issue/summary request on a duplex channel already bound by the trusted launcher, for example inherited FD 3. It does not listen publicly, accept caller-supplied identity/token, or add a route to the existing HTTP server. See [submission contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).

M4 permits a bounded private submission channel lifetime of up to one hour to match the authorized native launch. This is still one framed request, not public ingress. The supervisor must keep the descriptor private and terminate the process tree at expiry.

## M13 advisory issue completion hint

The existing authenticated `/issue-completed` cleanup sends only `{issueId}` to the **optional** protected memory client before local task-file cleanup (Mac remote cleanup unchanged), if configured. The shared-secret webhook, provider exit, local job JSON and body are *not proof* of PR merge, review, CI, Linear status or source provenance. The root operator coordinator must re-verify all evidence and reject unpinned jobs, stale approvals and incomplete commits. A missing/failed memory client never blocks the original cleanup response. No new HTTP route.

## M14 — preserve admission evidence until verified promotion

The existing authenticated `/issue-completed` route now asks the opt-in
protected root memory host for a **durably accepted hint before deleting**
the original task inbox. An `{status:"accepted",jobKey}` response identifies
the exact operator-pinned job with a durably accepted root intent; it **does
not mean** GitHub review, CI, Linear completion or native persistence passed.
Only that job's original task remains for the root worker's independent
verification; the HTTP response includes `memoryVerificationPending: true`.

An explicit `{status:"denied"}` permits ordinary cleanup of unmarked tasks.
An `{status:"uncertain"}` (including a timeout or lost response after possible
enqueue) conservatively retains authenticated issue task evidence until root
operator reconciliation. Previously marked tasks remain retained across
repeated callbacks or feature disablement. Neither an absent client nor an
uncertain response grants privileged authorization. The operator separately
clears retained tasks only after approved receipts and backup/rollback checks.


### Durable retention across repeated completion callbacks

The handler writes `memoryVerificationPending: true` into the exact
issue-matched canonical job ledger before it returns accepted retention.
Subsequent callbacks honor that durable marker even if the protected operator
refuses a duplicate, is offline, times out, or the optional feature is
temporarily disabled. A failure to persist the marker fails the request
before any task deletion. Replaying callbacks **never** automatically repeats
a native commit. Only the operator may explicitly clear that retention marker
after independent receipt/reconciliation and final cleanup approval.


### M14 exact pinned-job acknowledgments and uncertain-response retention

The root server returns the exact manifest-pinned job key alongside a durable
accepted completion acknowledgment. A duplicate for the same fsynced intent
returns the same pinned key without re-enqueueing a native write. A changed
manifest digest is denied.

The Bridge durably marks `memoryVerificationPending: true` for only the
matched pinned local job when the root response is confirmed. If the
transport times out or loses its reply after a possible enqueue, the result
is explicitly `uncertain`: the Bridge retains all local task evidence for
that authenticated issue pending operator reconciliation. A definitive
root denial cleans only records without earlier durable retention. Earlier
marks survive outages, restarts and repeated completion callbacks. Neither
a retention mark nor a webhook proves that native memory was approved.


## ABR-18 Phase 1 — optional GitHub EventIntelligence shadow receipts

The existing authenticated `/github/events` route may additionally write
metadata-only classified receipts when the operator explicitly sets
`EVENT_INTELLIGENCE_MODE=shadow`. The original `recordGithubEvent`, review
claim, dispatch/recovery, and HTTP responses remain authoritative and
unchanged. A shadow `dispatch` classification is **advisory only**, never
a second handoff. Failed shadow storage emits a redacted error code and
does not claim new review progress. No new public endpoint, model call,
Worker deployment, or production activation occurs in this phase.
