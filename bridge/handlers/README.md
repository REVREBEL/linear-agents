# Ingress handler owners

Canonical modules: `diagnostic-routes.mjs`, `review-routes.mjs`, `github-webhook-routes.mjs`, `trae-callback-routes.mjs`, `issue-completion-route.mjs`. Every handler keeps its existing authentication and callback contract. Compose them through `../server/http-route-composition.mjs`, never create an additional server or duplicate dispatch state.
