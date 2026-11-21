# ABR-59 M8 — Trusted GitHub review-evidence REST adapter

This module is an **unwired, host-only** implementation of the GitHub interface required by `verifyPromotionFromGitHub` in the M3/M4 promotion flow. It does not activate memory writing, create a GitHub App installation, discover credentials or authorize an agent from webhook/model/MCP claims.

## Authentication and API boundary

`createGitHubReviewClient({tokenProvider})` requires a host-owned callback returning a short-lived GitHub App installation token for every request. The callback and its key custody must be injected from trusted orchestration, **never** from Linear issue descriptions, GitHub review comments, prompts, or memory data. This module has no environment-variable credential fallback. Requests use only HTTPS `api.github.com`, static `/repos/{owner}/{repo}/...` endpoints and GET requests, with GitHub REST version `2022-11-28`. Cross-host redirects are refused. Errors are sanitized to a fixed exception message so token values and private GitHub responses do not enter logs.

The adapter implements four precise methods: `getPullRequest(repository, number)`, `listReviews(repository, number)`, `listCheckRuns(repository, fullHeadSha)`, and `getCollaboratorPermission(repository, login)`. Reviews and check runs are paginated at 100 per page; maximums of 1000 reviews and 2000 check runs, with failures on over-limit pagination, contradictory or incomplete check-run totals, malformed payloads, HTTP status failures and timeouts. Responses are capped to 256 KiB each, with no user-selected URLs. Native `filter=all` for check runs includes reruns; the existing M3 verifier then selects the newest run ID for each explicitly required check, checks authorized reviewer permissions, rejects superseded approvals and re-reads the merged PR head after validation.

## Verification and activation gates

Tests use mocked HTTPS responses to exercise the **actual M3 promotion verifier** through the adapter, with correct current SHA, reviewer, CI and permission evidence. They also cover pagination, truncation, contradictory total counts, bad tokens/HTTP status, bounded responses and path-injection attempts. Run `node --test memory/github-review-client.test.mjs` and the repository bridge/reliability suites.

**No live GitHub API calls or production credential loading** occur in tests. Host GitHub App installation-token acquisition, permission configuration and credential rotation must be supplied and reviewed separately. A trusted Linear completion reader, signing-key custody, production database least-privilege/RLS review, cross-tenant canaries and controlled activation remain outstanding. The default feature state is unchanged and no service or database is modified.
