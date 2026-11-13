# ABR-28 P4: Routing and Jobs Module Boundary

This change begins the bridge decomposition without relocating or changing mutable job data.

## Canonical modules

- `routing/host-routing.mjs` owns execution-host label interpretation, trusted macOS project scope mapping, and SSH configuration validation.
- `jobs/ordered-progress.mjs` owns per-process asynchronous progress ordering.
- `jobs/job-store.mjs` is the canonical filesystem-backed job ledger implementation, preserving the exact public API, record formats, atomic claims and transition semantics from the legacy module.

The former module entrypoints `linear-agent-bridge/host-routing.mjs` and `linear-agent-bridge/ordered-progress.mjs` remain as pure re-export compatibility shims. No duplicated state or independent implementation exists behind the legacy imports. The main server imports the canonical modules directly, and `ssh-dispatch.mjs` imports canonical host routing directly.

The legacy `linear-agent-bridge/job-store.mjs` is likewise a pure `createJobStore` re-export. Its module path continues working with the canonical function identity; only implementation source is relocated.

## Runtime invariants

- The `linear-agent-bridge/agent-bridge.mjs` entrypoint stays at its existing path for Ubuntu systemd and macOS LaunchAgent.
- `PROJECT_DIR`, `JOBS_DIR`, job-store creation, the `linear-jobs/` ledger, job IDs, review handoff state, and agent conversation files remain untouched.
- No Cloudflare Worker name, OAuth app, deployed script, secret, KV namespace or Durable Object is changed.
- No deployment or service restart is performed or authorized in this PR.

## Verification

The `scripts/p4-module-boundaries.test.mjs` regression suite verifies function identity across old and new imports, host-routing behavior, ordered queue failure recovery and the unchanged job ledger location. Both `bridge:test` and `test:reliability` include these checks; existing host-routing, SSH, and ordered-progress tests remain unchanged.

This is the first low-risk P4 boundary. Migrate other domains in separate small PRs, with their original entrypoints intact until validated. Do not move the active job store and live state merely because its source modules are reorganized.

## P4 conversation/session boundary

- `conversations/agy-conversation-state.mjs` is now the canonical source of the Antigravity conversation-resume ledger transition.
- `conversations/agy-session-queue.mjs` is now the canonical per-Linear-session in-process serialization queue.
- The original `linear-agent-bridge/agy-conversation-state.mjs` and `linear-agent-bridge/agy-session-queue.mjs` paths remain pure re-exports. The bridge imports canonical modules directly.
- The original `JOBS_DIR` and `job-state` records remain the only persisted session/recovery source. Conversation verification timestamps, source metadata, session IDs and concurrent dispatch behavior retain their previous semantics.
- Isolated GitHub dispatch/review-inbox integration fixtures now copy the canonical `conversations/` modules along with `routing/` and `jobs/`.

Regression tests cover function identity, actual persisted resume transitions through the legacy entrypoint, preservation of original verification metadata, concurrent session isolation, same-session ordering, and recovery after a failed queued task.

This PR does not introduce new persisted session directories, relocate existing records, change agent runner CLI flags, alter provider conversation identities or restart the bridge.

## P4 checkpoint and long-term recall boundary

- `memory/active-task-memory.mjs` is the canonical implementation of durable, redacted per-issue checkpoints.
- `memory/memu-memory.mjs` is the canonical optional memU retrieval adapter.
- The two old `linear-agent-bridge/*-memory.mjs` paths remain pure re-exports. The main server imports the canonical sources directly.
- `activeTaskMemory = createActiveTaskMemory(JOBS_DIR)` is unchanged. The checkpoint directory remains `linear-agent-bridge/linear-jobs/active-task-memory/` and existing revision, file lock, redaction, expiration and promotion behavior are preserved.
- memU retrieval remains disabled unless configured; failures continue without long-term recall rather than blocking jobs.

Both isolated bridge integration fixtures stage `memory/` alongside `routing/`, `jobs/`, and `conversations/`. Added tests validate one shared module identity, persisted checkpoint reads/writes through both import paths, revision checks, sensitive text redaction, and memU fail-open behavior.

No database change, checkpoint migration, external memU setup, runtime data movement, Worker deployment, or Ubuntu restart is included.

## P4 GitHub PR task-memory boundary

- `memory/github-task-memory.mjs` is the canonical per-PR short-term review/deduplication memory implementation.
- `linear-agent-bridge/github-task-memory.mjs` remains a compatibility re-export with the same function identity.
- The bridge imports the canonical module and still calls `createGithubTaskMemory(JOBS_DIR)`.
- Runtime files remain under `linear-agent-bridge/linear-jobs/github-events/task-memory/`; the SHA-256 per-PR filename mapping, record schema and atomic replacement semantics are unchanged.
- Review state, previous head SHA, decision, and processed change markers continue to be read from the existing journal directory. No checkpoint or event journal files are moved.

The new regression proves old/new import identity, read/write interoperability for a single PR, persistence of previous review markers, and preservation of the hashed filenames in the original folder. No change to GitHub webhooks, ChatGPT review inbox routing, duplicate suppression policy, or runtime job orchestration occurs in this extraction.

## P4 GitHub event ingress and classification boundary

- `integrations/github-events.mjs` owns GitHub event envelope validation, sanitization, journaling, first-pass actionable classification, explicit self-origin filtering, change-key generation, review destination resolution and prompt construction.
- `linear-agent-bridge/github-events.mjs` remains a compatibility-only re-export of the identical functions. Both `agent-bridge.mjs` and `review-inbox.mjs` import the canonical module.
- Runtime journal records remain anchored to `JOBS_DIR/github-events/events.jsonl`. Comment bodies are excluded from persisted event journals.
- Event payload contracts, accepted GitHub event/action names, external review handoff, idempotent task memory and user-vs-CLI identities are unchanged.

Isolated bridge fixtures copy `integrations/` as well as existing domain folders. New regressions prove the old/new exports are the same functions, explicitly configured self-origin identities still suppress matched events (while no implicit identity suppresses unrelated events), and journal records retain their exact path and redaction behavior.

No GitHub App or webhook subscription changes, no deployed Worker changes and no live state migration.

## P4 review inbox and claim boundary

- `bridge/review-inbox.mjs` becomes the canonical reviewer inbox implementation.
- `linear-agent-bridge/review-inbox.mjs` remains a pure compatibility re-export, preserving the exact function identity.
- The main bridge imports the canonical implementation and still instantiates `createReviewInbox(JOBS_DIR)`; existing records remain under `linear-agent-bridge/linear-jobs/github-events/review-inbox/`.
- Distinct ChatGPT user-review role, SHA-derived review identifiers, duplicate suppression, atomic cross-process lock/rename behavior, claim transitions, mandatory published-review verification and idempotent message-handoff attempt tracking remain unchanged.
- The isolated Linux bridge boot test fixtures stage `bridge/` in addition to the previous canonical folders.

New regression checks old/new import identity, persistent queue interoperability, claim exclusivity, rejection of unverified published-review outcomes, retained permissions, and no automatic replay after an uncertain ChatGPT message handoff.

The purpose is only to relocate orchestration source code. No pending reviews, message submissions or live files are moved or replayed, and no deployment or Ubuntu service changes are authorized.

## P4 published review delivery, Mac message handoff and Linear notification boundaries

- `bridge/review-delivery.mjs` now verifies a published GitHub review against the current PR head and configured reviewer identity. `linear-agent-bridge/review-delivery.mjs` remains a pure re-export.
- `bridge/review-message-handoff.mjs` retains the trusted SSH runner configuration, validated ChatGPT conversation URLs, bounded payloads and explicit handoff acknowledgments. `linear-agent-bridge/review-message-handoff.mjs` remains a pure re-export.
- `integrations/review-linear-notifier.mjs` manages deterministic Linear review issue IDs, user-review assignment and idempotent create/update. `linear-agent-bridge/review-linear-notifier.mjs` remains a pure re-export.
- The bridge imports all three canonical sources directly. No existing worker, webhook, authentication, host, file path or runtime service configuration is modified.
- Existing review inbox state, single-attempt submission markers, duplicate claims, and reviewed-state validation are unchanged.

Tests assert canonical/legacy export identity, exact-commit published review evidence, immutable Linear review issue identity and human reviewer role, SSH trusted runner constraints, and original bridge data root.

No review submission, GitHub API call, Linear mutation, deployment or runtime data migration is made by this refactor.

## P4 Linear OAuth agent-credential boundary

- `integrations/linear-credentials.mjs` is the canonical runtime adapter for per-agent Linear app access tokens.
- `linear-agent-bridge/linear-credentials.mjs` remains a pure compatibility re-export of `LINEAR_AGENT_VARS`, `writeLinearEnv`, and `syncLinearCredential`.
- The main bridge imports the canonical module directly, without changing its HTTP startup path, trusted Worker completion origin checks, token fetch endpoint, or agent identity mapping.
- Short-lived access tokens remain isolated by agent environment variable, including separate `CHATGPT_LINEAR_API_KEY` and `CHATGPT_CLI_LINEAR_API_KEY`.
- The existing per-repository `.env.linear-bridge` location, tracked-file refusal, Git exclusion, atomic permissions and rotation semantics remain unchanged.

No access token or refresh token is added to the repository. This extraction does not change worker credentials, trigger reauthorization, alter deployment configuration, or run production credential synchronization.

The new compatibility regression checks re-export identity, human-review versus CLI variable isolation, token endpoint authentication, disabled persistence and HTTPS completion URL rejection. Existing secret-storage and workspace-exclusion tests continue to run.

## P4 remote Trae callback and SSH dispatch boundaries

- `routing/remote-trae-activity.mjs` is the canonical implementation for per-job remote activity token hashing, callback authentication and HTTPS Trae endpoint validation.
- `routing/ssh-dispatch.mjs` is the canonical implementation for trusted macOS SSH launcher arguments, explicit runner acknowledgement, completion reconciliation and remote cleanup.
- Both old `linear-agent-bridge/` paths remain pure compatibility re-exports. `agent-bridge.mjs` imports canonical routing implementations directly.
- The canonical SSH adapter imports the already-canonical `routing/host-routing.mjs` sibling. No trusted host defaults, command quoting, callback path, per-job capability token, session matching, SSH handshake or durable completion-state behavior changes.
- Existing `JOBS_DIR` and `linear-jobs/` records are unchanged; no remote sessions are launched or resumed by this source move.

Regression checks confirm old/new function identity, strict job/session/workspace/token matching, endpoint validation, trusted SSH configuration and unchanged runtime ledger anchoring. Existing isolated bridge fixtures already stage `routing/` and do not need modification.

## P4 HTTP transport primitives

- `bridge/http-helpers.mjs` now exports the exact existing bridge host-header normalization, host matching, request-body reading and JSON response helpers.
- The entrypoint `linear-agent-bridge/agent-bridge.mjs` imports these stateless helpers; the main `http.createServer` request dispatcher and all HTTP route branches remain in their original locations.
- The 1,000,000-byte body limit and overflow request destruction remain unchanged. Successful body decoding still uses UTF-8.
- JSON responses preserve their status codes, indentation, `application/json; charset=utf-8` content type and `cache-control: no-store` header.
- Hostname comparison semantics, including accepted subdomains, remain identical. No new trust assumptions or route matching behavior are introduced.

Regression tests verify host handling, exact response serialization, oversized-request rejection and the continued presence of the HTTP route table in the existing systemd/LaunchAgent entrypoint. The existing integration tests continue exercising authenticated review and GitHub webhook endpoints.

This PR makes no changes to authentication, side-effecting route handlers, job creation, on-disk paths, HTTP listener binding, deployed worker names, live state or service startup scripts.

## P4 isolated HTTP diagnostics route handling

- `bridge/diagnostic-routes.mjs` now owns only the GET `/health` and POST `/diagnostics/probe` HTTP route handlers. It uses the existing shared JSON serialization helper and returns a boolean indicating whether a request was handled.
- The main bridge still creates the HTTP listener, normalizes the host header, parses the URL and retains the entire job and webhook request dispatch table in the original entrypoint.
- Health payload field names, values, `local-linear-agent-router` service name, JSON response headers and status are unchanged. Configuration values remain sourced by the original runtime entrypoint, not relative to the new module.
- The probe continues to enforce the configured `BRIDGE_SHARED_SECRET` Bearer header, existing UUID-shaped probe-ID validation and the existing `agentForHost` selection. Unauthenticated or malformed probe requests are rejected without job operations.
- Non-diagnostic routes continue through exactly the same handler code. Review inbox, credentials, jobs, memory and journal storage paths, service host binding and all provider callbacks are untouched.

The new regression covers the full health shape, correct 401 and 400 responses, successful probe metadata, a missing secret, non-diagnostic fall-through, unexpected HTTP methods and the continued original HTTP server/job-route location. No production probe, service restart or deployed Worker change is performed.

## P4 ChatGPT user-review HTTP routes

- `bridge/review-routes.mjs` now handles only the existing `/reviews/*` endpoints. It receives the existing inbox, GitHub publication verifier and timing-safe token comparator from the unchanged bridge entrypoint.
- The main `linear-agent-bridge/agent-bridge.mjs` still owns the HTTP listener, host selection, process configuration, lifecycle and every other route; unmatched requests fall through without side effects.
- Existing `CHATGPT_REVIEW_MODE=inbox`, dedicated `CHATGPT_REVIEW_INBOX_TOKEN` (minimum 32 chars), review-user authentication, pending list, claim and completion endpoints preserve their response shapes and status codes.
- A `reviewed` completion continues to require a previously claimed task and independently verified published GitHub review of the expected head SHA by the configured reviewer identity. Unverifiable publication still returns conflict rather than marking a task complete.
- The review inbox persists under the same `JOBS_DIR/github-events/review-inbox/` directory. No records, handoff attempts, credentials, Worker endpoints, or active sessions are moved or replayed.

Regression tests verify unauthorized denial, enabled/disabled route modes, claim and published-review completion dependencies, unsupported operations, conflict responses and non-review fallthrough. Existing full bridge API tests remain in the CI suite.

## P4 GitHub webhook HTTP handler boundary

- `bridge/github-webhook-routes.mjs` is the canonical POST `/github/events` handler, with transport and authenticated delivery intake extracted from the monolithic HTTP listener.
- The main `linear-agent-bridge/agent-bridge.mjs` still owns the HTTP server, process lifecycle, GitHub review dispatch coordinator, task memory and underlying job/review persistence. The handler receives these existing capabilities through explicit dependencies.
- Exact shared-secret Bearer authentication, allowed ChatGPT/Antigravity sources, sanitized event envelope, platform-specific review handoff preflights, inbox minimum-token requirement and Linear user-review notification prerequisites are preserved.
- Delivery claims still use `JOBS_DIR/github-events/<source>-<delivery>.claim` with exclusive file creation. Existing semantic review dispatch claims, duplicate delivery retry/recovery behavior, GitHub event journal writes and short-term PR memory updates are unchanged.
- Retained original `202`, `400`, `401` and `503` outcomes and response bodies. On processing errors, uncommitted claims are still removed to permit retry; unrelated routes continue to the same existing main router.

Added regression coverage for denied/invalid requests without disk or dispatch side effects, preflight rejection without claim, accepted event journaling, duplicate replay suppression, and rollback of a failed delivery claim. Existing full bridge web-hook tests continue to run.

No production webhook, review or PR notification is sent by this source-only extraction. No job files, bridge configuration, Cloudflare deployment, SSH runner or Ubuntu service is changed.

## P4 Trae remote activity and completion HTTP endpoints

- `bridge/trae-callback-routes.mjs` now handles only POST `/trae-activity` and POST `/trae-complete`. The original `linear-agent-bridge/agent-bridge.mjs` continues to own the listening server, durable job store, project root, remote-session lookup, activity throttling map, and Linear activity publisher.
- Authenticated remote activity still requires a per-job capability token, the exact agent/session/workspace identity, eligible job state and confirmed HTTPS completion endpoint. The legacy workspace-session validation path remains unchanged.
- Progress events retain the existing 10-second per-session throttle and 60-second duplicate-body suppression. Activity records are updated only after successful Linear publication.
- Terminal callbacks still require `completed` or `failed`, a bounded nonempty response, successful Linear publication before a durable job transition, and an idempotent 202 duplicate result for already-completed matching jobs. In particular, SSH closure alone never marks a job completed.
- All callback URLs and response status codes are preserved; other methods and paths fall through to the main bridge unchanged. Existing job files, session IDs and `linear-jobs/` layout are not moved.

New P4 regressions cover capability authorization, progress throttling, invalid terminal states, confirmed completion ledger updates, duplicate completed callbacks and listener/storage anchors.

No real callback, production agent launch, Cloudflare deploy, Ubuntu service restart or persistent-state migration is performed.

## P4 issue completion cleanup route

- `bridge/issue-completion-route.mjs` handles only authenticated POST `/issue-completed`, with dependencies on the existing job store and Mac cleanup dispatcher rather than creating new state ownership.
- The main `linear-agent-bridge/agent-bridge.mjs` retains the HTTP listener, `/jobs` endpoint, job creation/routing, process lifecycle, original `JOBS_DIR` and active sessions.
- The route preserves the bridge Bearer token requirement, UUID-shaped issue ID validation, `findByIssueId` lookup, original `200`, `400`, `401` status codes and `{ok,issueId,cleaned}` response.
- macOS remote cleanup continues through the trusted SSH dispatcher, skips already-cleared inbox records and updates `inboxClearedAt` only after the remote cleanup completes successfully. Local cleanup remains restricted to JSON inbox paths under `.linear-agent/projects/.../inbox/`. A missing local file is still tolerated while other file-system errors propagate.
- No existing persisted job records are moved or rewritten by the refactor itself; cleanup only occurs on an authenticated runtime request as before.

New tests verify unauthorized/malformed requests have no side effects, non-route fallthrough, macOS ACK-before-transition ordering, exact local inbox path filtering and original job-store ownership.

## P4 Linear job admission and duplicate-claim policy

- `jobs/job-admission.mjs` now defines the pure delivery-identity and duplicate-response policy for authenticated POST `/jobs`. The existing HTTP route still reads and authenticates requests, resolves job routes, synchronizes agent credentials, and owns the live job ledger and all agent launch branches.
- `identifyLinearJobDelivery` retains the original upstream webhook ID in the per-agent ledger key while sanitizing only the filesystem-safe job ID. When an upstream delivery ID is absent, it preserves the SHA-256 body hash for retry idempotency and the original generated display job-ID semantics.
- `linearJobDuplicateResponse` retains fail-closed 503 responses for old `claimed`, `received`, `unrouted`, `failed`, or `interrupted` records. Only accepted job states receive a 202 duplicate acknowledgement with the original job ID.
- The bridge still resolves the job route and synchronizes credentials **before** claiming a delivery so transient failures remain retryable. All `JOBS_DIR`, task-file, active memory, agent isolation and execution state transitions remain anchored to the original bridge.
- The main HTTP listener and platform-specific agent launch paths are deliberately not moved by this slice.

Regression coverage verifies raw-vs-sanitized webhook IDs, independent ChatGPT user and CLI keys, deterministic fallback deduplication, rejected partial/failed duplicates, accepted replay response shape and critical admission ordering.

No production job is submitted or dispatched, no live data migrated, and no Ubuntu service, Worker or credential configuration changed.
