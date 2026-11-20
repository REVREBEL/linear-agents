# ABR-92 M1 — Trusted post-review promotion gate

This module implements **verification only**, not memory evolution or commit. It closes the old assumption that a caller-supplied `verification.json`, model-authored note, or MCP tool response can establish review and CI authority.

## Verified installed interface

On the Ubuntu Bridge host, `/opt/agents/memu/.venv/bin/memu --help` exposes only `retrieve`, `search`, `list-files` and `commit`. Its `commit` input is a JSON payload containing `recall_files` and `resource`, not a canonical session. The Python package additionally contains a **separate host adapter** `memu.hosts.host_cli` with `prepare`/`commit` and bridging pipeline, but that adapter's session sources, host working state, executor files and trust contract are not equivalent to the core `memu` binary. In particular the original `scripts/memu-promote.mjs` command `memu memorize prepare` is unsupported here. Do not use a guessed command or model-produced SQL.

## Authority contract

`memory/promotion-verification.mjs` exports `verifyPromotionFromGitHub`. It requires a Bridge-owned authenticated client with **complete paginated** `getPullRequest`, `listReviews`, `listCheckRuns`, and `getCollaboratorPermission` methods, a trusted job-bound tenant/agent/repository/issue scope, full 40-character expected head SHA, explicit required CI names and CI app allowlist. It confirms the merged current PR head belongs to the intended repository, checks the latest decision from each reviewer (dismissals and change requests invalidate earlier approvals), rejects author self-approval, and checks the review commit equals the exact head SHA. A reviewer must hold current write/maintain/admin repository permission, and every required check must have a successful latest trusted-app run on the **same** head SHA. It re-reads PR state at the end to detect concurrent head changes.

The returned evidence includes reviewer ID, review timestamp, check-run IDs, PR, merge commit SHA and scope, but **does not** grant commit rights. Caller identity and issue ownership must come from Bridge's authenticated job ledger, not input JSON; the verification client is injected and cannot be supplied by the agent. A raw `verification.json` is only a preflight claim. `scripts/memu-promote.mjs` now refuses a standalone invocation and cannot reach a subprocess even with verified proof because the host evolve/commit compatibility and durable journal are not yet validated.

## Acceptance and remaining work

`node --test memory/promotion-verification.test.mjs` covers current approved, stale, missing, dismissed, superseded, self-authored, wrong repository, permission-denied, unmerged, changed-head, wrong SHA, failed CI, untrusted app, duplicate/newer failed check and malicious tool-input cases. Tests use an injected, deterministic trusted-client fixture; **they are not a live GitHub approval or memU write canary**.

Before enabling any persistent promotion, ABR-92 still requires a real Bridge GitHub App adapter with exhaustive pagination and repository authorization, trusted completed-session transcript provenance and redaction, host-adapter execution compatibility, serialized evolve, durable per-scope journal/idempotency, crash recovery, exact promotion-stage schema validation, disposable storage tests, scoped recall, and operator-approved rollout. No database, service, credential or memU state is changed by M1. Rollback of this review-only slice is removal of its module/verification hook; promotion remains disabled regardless.
