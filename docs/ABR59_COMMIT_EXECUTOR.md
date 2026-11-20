# ABR-59 M4 — Verified memU commit executor and disposable canary

## Source and authorization contract

The installed memU 0.10 CLI accepts prepared JSON through the command `memu commit - --json`, with keys `recall_files`, `resource`, and `user`. It **does not** provide the historical `memorize prepare` verb. The default user model supports only `user_id` and `agent_id`; the current native `retrieve` verb does not implement a trusted four-field tenant/agent/repository/issue filter. Live multi-tenant retrieval is not authorized by this commit contract.

The new `executeVerifiedMemuCommit` is an **unwired, explicitly-injected** primitive. Callers must provide a durable M3 journal receipt, an authenticated GitHub App client with current same-SHA merged PR/authorized review and passing required CI, an independently authenticated Linear client that confirms a completed issue plus matching repository/head SHA, a separate trusted source verifier that attests content against the exact Git commit/path/revision, and an explicitly supplied memU commit implementation. Caller-provided agent text, webhook claims, MCP outputs, and unsigned memories cannot authorize a write.

The canonical prepared payload has a single memory-track recall file named deterministically by the receipt ID, scoped `user_id` as the SHA-256 of tenant/repository/issue, plus `agent_id`. It rejects common credential patterns, known prompt directives, non-printable content, unsafe paths, mismatched SHA or empty/oversized learnings. Source verification is injected, **not built** in M4; the executor cannot be activated until trusted Bridge implementations of its interfaces have been independently reviewed.

## Durable one-shot semantics

The executor validates evidence and source before creating a private, exclusive, fsynced `.commit-started` marker. The marker is durably published before the irreversible memU call. A result must confirm the deterministic recall file name, after which `.commit-confirmed` is synced. If the process crashes or any result is ambiguous, **automatic retry is prohibited**, even after restart: the marker intentionally remains, and an operator must reconcile the native DB state before any future attempt. This prevents unbounded or duplicate writes; it is not a complete automated crash-recovery workflow.

## Native CLI adapter and verified disposable canary

`commitMemuInDisposableDatabase` invokes the approved absolute memU binary directly with JSON via stdin, bounded time/input/output, sanitized errors, private runtime config and a restricted environment. It **only** accepts a new disposable SQLite path below the invoking process's temporary directory; parent must be mode 0700 and owned, and pre-existing paths or symlinks are rejected. It cannot point to the production PostgreSQL `agent_memory` database.

`scripts/memu-disposable-canary.mjs` builds and tears down a private temporary SQLite database, writes one synthetic learning through the real installed CLI, then tests semantic retrieval with local Ollama `nomic-embed-text`. On the Ubuntu host, `/tmp` is owner-only root and the Bridge user cannot write to it. Run as the Bridge account with `TMPDIR=/var/tmp`; no secrets or memory contents are printed. Verified result: `{"disposable":true,"committed":true,"retrieved":true,"model":"nomic-embed-text"}`.

## Remaining requirements

This milestone does not wire native or remote agents to commit, does not enable automatic promotion or agent prompt use, does not create storage-level row security, and does not write live memory. Next steps: trusted GitHub/Linear/source-verifier host adapters; source-backed sanitation and approval authority; durable production write/reconciliation strategy including ambiguous outcomes; read-side authorization against native memU's actual schema; tests proving scoped cross-session retrieval without leakage; explicit reviewed production opt-in.

Test: `node --test memory/memu-commit-executor.test.mjs memory/native-memu-commit.test.mjs`, plus the registered bridge/reliability suites. No service restart, live database migration or background agent assignment is performed by this PR.
