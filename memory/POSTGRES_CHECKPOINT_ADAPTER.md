# ABR-3: PostgreSQL checkpoint adapter (experimental)

This branch provides an **opt-in, unconnected** PostgreSQL persistence boundary.
It does not replace the running file-based checkpoint store, deploy memU, or
connect to the production `agent_memory` database.

## Contract

- `createPostgresCheckpointStore(db)` accepts a caller-provided `pg`-compatible
  query client. The project does not currently include a PostgreSQL Node driver.
- `read({tenantId, agentId, repositoryId, issueId})` returns a JSON checkpoint
  or `null` for that exact scope.
- `update(scope, completeCheckpointSnapshot, expectedRevision)` performs an
  atomic compare-and-swap. Initial revision must be zero; each successful write
  increments it by one. On mismatch it throws `ECONFLICT`.
- The update is a **full replacement snapshot**, not a patch merge. Callers
  must read, construct, sanitize, and retry on revision conflict. It is not a
  drop-in replacement for `createActiveTaskMemory` yet.
- Sanitization reuses `sanitizeCheckpoint`; scope and revision are server-owned.
- The PostgreSQL role must have only SELECT/INSERT/UPDATE privileges in the
  dedicated `memory` schema. A shared role is not a database-enforced tenant
  isolation boundary: application authentication must independently bind each
  scope to the authorized tenant/agent. Consider RLS and per-agent credentials
  before enabling a multi-tenant production workload.

## Verification

```bash
node --test memory/postgres-checkpoint-store.test.mjs linear-agent-bridge/active-task-memory.test.mjs
bash memory/scripts/verify-postgres-checkpoints.sh
```

The SQL verification creates and destroys a **disposable PostgreSQL 18 cluster**
under `/tmp` on port `55439`, using local `postgres` OS identity. It never
starts the installed `18/main` cluster or alters systemd, the existing data
volume, `wikijs_db`, or `n8n_db`. It requires root access for the temporary
cluster's `postgres` user, and will refuse to start if the test port is busy.

## Deployment gates

1. Recover or account for the previously provisioned PostgreSQL 17 data and
   confirm the target server, backup and rollback plan before any production
   migration. **Do not initialize over existing or potentially recoverable data.**
2. Add and pin a supported PostgreSQL client driver, validate credentials and
   TLS, and use an approved database migration runner.
3. Add a compatible checkpoint API adapter and safe migration/backfill with
   shadow reads, dual-write failure behavior, and rollback.
4. Prove actual concurrent multi-process CAS, agent/tenant isolation, failure
   recovery, restart durability, and authorized role privileges against the
   selected deployment database before enabling live traffic.
5. Separately implement a trusted memU evolve executor; this adapter does not
   authorize transcript promotion or model-generated SQL.

## Verified server configuration (November 18, 2026)

The Ubuntu host has **PostgreSQL 18/main online at port 5433**, with pgvector
0.8.1 enabled in `agent_memory`. The installed memU CLI is 0.10.0 in
`/opt/agents/memu/.venv`, configured through bridge-owned mode-0600
`/home/bridge/.memu/config.env`. It uses local Unix peer authentication,
`memu` schema, and Ollama `nomic-embed-text` (768 dimensions). A real memU
commit/retrieve canary passed; the bridge adapter's retrieval output was also
verified against the live database. PostgreSQL and Ollama are enabled at boot.

`memory/memu-memory.mjs` now handles memU 0.10's `segments/files/resources`
response, retaining compatibility with older `hits` results. Retrieval remains
**disabled by default** in the running bridge; even when enabled, recalled
text is intentionally withheld from the agent prompt pending security review.

The existing `memory/active-task-memory.mjs` is the operational per-issue file
checkpoint, and `memory/github-task-memory.mjs` is per-PR review state.
Event Intelligence owns separate advisory review-checkpoint logic, and the
ChatGPT reviewer Worker is not the ChatGPT CLI coding runtime. None of these
paths are replaced by the new PostgreSQL adapter in this draft PR.

The pre-existing collation mismatch affects `postgres` and `template1` (older
collation version 2.39 vs OS 2.43); `agent_memory` was created from `template0`
with current collation 2.43. Do not blindly refresh template collation without
reviewing any affected indexes.
