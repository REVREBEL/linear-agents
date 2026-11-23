# Ingress handler owners

Canonical modules: `diagnostic-routes.mjs`, `review-routes.mjs`, `github-webhook-routes.mjs`, `trae-callback-routes.mjs`, `issue-completion-route.mjs`. Every handler keeps its existing authentication and callback contract. Compose them through `../server/http-route-composition.mjs`, never create an additional server or duplicate dispatch state.

## ABR-17 M2 — Private submission channel

`submission-channel.mjs` handles one bounded newline-delimited issue/summary request on a duplex channel already bound by the trusted launcher, for example inherited FD 3. It does not listen publicly, accept caller-supplied identity/token, or add a route to the existing HTTP server. See [submission contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).

M4 permits a bounded private submission channel lifetime of up to one hour to match the authorized native launch. This is still one framed request, not public ingress. The supervisor must keep the descriptor private and terminate the process tree at expiry.

## M13 advisory issue completion hint

The existing authenticated `/issue-completed` cleanup sends only `{issueId}` to the **optional** protected memory client after normal ledger/Mac cleanup, if configured. The shared-secret webhook, provider exit, local job JSON and body are *not proof* of PR merge, review, CI, Linear status or source provenance. The root operator coordinator must re-verify all evidence and reject unpinned jobs, stale approvals and incomplete commits. A missing/failed memory client never blocks the original cleanup response. No new HTTP route.

## M14 — preserve admission evidence until verified promotion

The existing authenticated `/issue-completed` route now asks the opt-in
protected root memory host for a **durably accepted hint before deleting**
the original task inbox. A `true` result means only that the exact pinned
issue/job passed canonical operator admission and its root-private intent
was accepted; it **does not mean** GitHub review, CI, Linear completion or
native persistence passed. The original inbox remains for the root worker's
independent task/tenant/session verification and reconciliation; the HTTP
response includes `memoryVerificationPending: true` and `cleaned: 0` for
that accepted pinned local issue.

Absent or untrusted host, a rejected/invalid issue, a failed request, timeout,
or any return value other than the boolean `true` preserves the **existing
ordinary cleanup** semantics, with no privileged fallback. The root operator
must complete the verified lifecycle and separately clear the retained task
only after final approved receipt and backup/rollback acceptance.


### Durable retention across repeated completion callbacks

The handler writes `memoryVerificationPending: true` into the exact
issue-matched canonical job ledger before it returns accepted retention.
Subsequent callbacks honor that durable marker even if the protected operator
refuses a duplicate, is offline, times out, or the optional feature is
temporarily disabled. A failure to persist the marker fails the request
before any task deletion. Replaying callbacks **never** automatically repeats
a native commit. Only the operator may explicitly clear that retention marker
after independent receipt/reconciliation and final cleanup approval.
