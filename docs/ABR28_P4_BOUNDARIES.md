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
