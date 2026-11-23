# Ingress handler owners

Canonical modules: `diagnostic-routes.mjs`, `review-routes.mjs`, `github-webhook-routes.mjs`, `trae-callback-routes.mjs`, `issue-completion-route.mjs`. Every handler keeps its existing authentication and callback contract. Compose them through `../server/http-route-composition.mjs`, never create an additional server or duplicate dispatch state.

## ABR-17 M2 — Private submission channel

`submission-channel.mjs` handles one bounded newline-delimited issue/summary request on a duplex channel already bound by the trusted launcher, for example inherited FD 3. It does not listen publicly, accept caller-supplied identity/token, or add a route to the existing HTTP server. See [submission contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).

M4 permits a bounded private submission channel lifetime of up to one hour to match the authorized native launch. This is still one framed request, not public ingress. The supervisor must keep the descriptor private and terminate the process tree at expiry.

## M13 advisory issue completion hint

The existing authenticated `/issue-completed` cleanup sends only `{issueId}` to the **optional** protected memory client after normal ledger/Mac cleanup, if configured. The shared-secret webhook, provider exit, local job JSON and body are *not proof* of PR merge, review, CI, Linear status or source provenance. The root operator coordinator must re-verify all evidence and reject unpinned jobs, stale approvals and incomplete commits. A missing/failed memory client never blocks the original cleanup response. No new HTTP route.
