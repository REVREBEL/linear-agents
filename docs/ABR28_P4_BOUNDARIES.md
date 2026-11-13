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
