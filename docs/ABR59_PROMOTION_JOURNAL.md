# ABR-59 M3 — Durable verified promotion staging

This is a private, **authorization-receipt-only** milestone. It does **not** execute memU prepare/evolve/commit, grant memory-reading authority, or enable production services.

## Contract

The caller injects a Bridge-owned authenticated GitHub client into createPromotionJournal({root}).stageVerified(). The journal always invokes verifyPromotionFromGitHub for the exact tenant, agent, repository, issue, merged PR number, full PR head SHA, authorized reviewer and required successful same-SHA CI checks. It cannot stage records based on arbitrary model output, self-declared approvals, untrusted Linear webhook payload claims, or MCP-generated evidence.

A receipt is keyed by SHA-256 of all four scope dimensions plus PR number and commit SHA, written under a private, owner-only journal root using mode-0600 files. Complete JSON is synced to an unadvertised staging file, then published under its deterministic key via an exclusive hard link, followed by directory fsync. If a process crashes during staging, orphaned temporary files are ignored; a published record is complete. Concurrent duplicate submissions preserve the original evidence and never overwrite a receipt. Restart enumeration and exact-key lookup validate file permissions, owner, expected key, proof shape, and scope; corrupt or symlinked records fail closed.

Every record remains state = verified-awaiting-executor. It is proof of the verifier's prior judgment, not a license to write memU. Actual execution must revalidate current source authority and Linear completion, ensure session provenance and sanitized content, implement a crash-safe prepare/evolve/commit state machine and isolated idempotent memU writes, and prove cross-session scoped recall with a disposable database before enabling production posting. Existing core memU 0.10 offers a commit payload format but does not have the old memorize prepare verb.

## Tests and activation

Run node --test memory/promotion-journal.test.mjs. Tests cover approved GitHub proof, failed/revoked/incomplete evidence, deterministic keys, tenant/agent/repository/issue isolation, concurrent de-duplication, restart replay, insecure permissions, symlink/corrupt records, and orphaned crash staging. Both bridge and reliability suites include these tests.

This is a storage primitive only. There is no background watcher, live journal directory, service unit, production credential installation, memU commit call, database modification, or automatic issue transition in this PR. A later trusted orchestration hook must decide when to call it. Rollback is a code revert; disposal of a test-only temporary root is handled by the tests.
