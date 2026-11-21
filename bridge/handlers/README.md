# Ingress handler owners

Canonical modules: `diagnostic-routes.mjs`, `review-routes.mjs`, `github-webhook-routes.mjs`, `trae-callback-routes.mjs`, `issue-completion-route.mjs`. Every handler keeps its existing authentication and callback contract. Compose them through `../server/http-route-composition.mjs`, never create an additional server or duplicate dispatch state.

## ABR-17 M2 — Private submission channel

`submission-channel.mjs` handles one bounded newline-delimited issue/summary request on a duplex channel already bound by the trusted launcher, for example inherited FD 3. It does not listen publicly, accept caller-supplied identity/token, or add a route to the existing HTTP server. See [submission contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).
