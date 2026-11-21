# ABR-59 M10 — Native memU multi-scope PostgreSQL canary

## Reproduce on the Ubuntu host

From the repository root, run `/usr/sbin/runuser -u bridge -- bash memory/scripts/verify-memu-isolation.sh` as an authorized administrator. Alternatively run the script directly as the bridge OS user. Requires PostgreSQL 18 with pgvector, the installed memU 0.10 CLI, Node 26.13.0 and the bridge's private local embedding configuration. No production DB access or GitHub/Linear credential is needed.

The harness starts a newly initialized cluster in a private, randomly named directory under /var/tmp, using peer authentication and a private Unix socket with no TCP listener. It removes inherited PG* variables, creates only the disposable database abr59_canary, verifies actual connection identity/data directory, and constructs its own explicit DSN. Native memU receives a private HOME, local-only embedding configuration, a synthetic local API placeholder, and telemetry disabled. It receives neither the configured production DB DSN nor the production embedding credential. Git repositories, signing key, receipts, approvals, database and socket belong to the temporary fixture. The trap stops the disposable server before removal; stop failures retain the directory rather than delete a running cluster. The test is explicit and host-only, not a CI startup action.

## Verified workflow

- Generate independent synthetic Git commits and exact reviewed learning files for two repository identities.
- Use the real Git source verifier, promotion journal, verified commit executor and signed source store; inject synthetic GitHub review/check and Linear completion responses.
- Commit five distinct learning records using the installed native memU CLI and local nomic-embed-text. Vary tenant, agent, repository and issue individually from a baseline.
- Verify five persisted files and five distinct native user/agent pairs, matching file/segment scope labels, and 768-dimensional embeddings for all files and corresponding segments.
- Run the actual scoped PostgreSQL retrieval SQL, parameter binding and trust-envelope parser using a test-only subprocess wrapper that routes to the verified disposable socket. Check the exact expected text for every scope; reject foreign signed approval requests and cross-scope recall for all four independent variants.
- Reject duplicate promotion without invoking the write adapter; reject a changed DB row against its independently signed source and restore the original.
- Stop/restart PostgreSQL, launch a fresh Node process, reload the same private receipts and approvals and repeat all persistence, isolation, tamper and duplicate checks. Stop and remove the disposable cluster on exit.

## Host evidence (2026-11-20)

Ran on the Ubuntu bridge host as bridge, including a rerun with deliberately invalid inherited PGDATABASE, PGHOST, PGSERVICE and PGOPTIONS values. The final run exited 0 in 6.87 seconds:

| Check | Initial | After restart |
| --- | --- | --- |
| Native commits persisted | 5 | 5 |
| Exact scoped recalls | 5/5 | 5/5 |
| Independent scope mismatch denials | 4/4 | 4/4 |
| Signed source approval and tamper rejection | Pass | Pass |
| Duplicate promotion denied | Pass | Pass |
| Local vector dimensions | 768 | 768 |

## Acceptance boundary

This demonstrates native memU write/storage, Git-object verification, authorization-journal persistence, signed approvals, exact scoped application recall, and restart recovery on actual PostgreSQL. Retrieval is the existing approved-file lookup, not a semantic ranking claim. GitHub and Linear evidence is a fixture; this is not a live OAuth canary. The cluster owner runs the test; application filtering is not database-enforced tenant isolation. No production schema, DB, service or agent prompt is activated. M11–M14 still cover live authority/key custody, restricted database roles/production writer, actual Bridge lifecycle wiring and controlled activation.
