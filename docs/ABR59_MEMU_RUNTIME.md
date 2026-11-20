# ABR-59 M1 — Private memU runtime and read-only diagnostics

## Current installed contract (verified November 2026)

The Ubuntu host has the core memU CLI at `/opt/agents/memu/.venv/bin/memu`, with `retrieve`, `search`, `list-files`, and `commit`. The Bridge service account owns `/home/bridge/.memu/config.env` (file mode 0600). Its local memory mode uses provider `openai` through a loopback-only, OpenAI-compatible Ollama endpoint, with `nomic-embed-text` embeddings. memU 0.10 has no core `memorize prepare` verb; ABR-92 M1 did **not** enable a trusted evolve/commit executor.

Run `node scripts/check-memu-runtime.mjs` **as the `bridge` operating-system user** on the approved Ubuntu host. The diagnostic reads the private config without sourcing a shell file and checks the approved absolute CLI executable. It runs a fixed read-only PostgreSQL query via `/usr/bin/psql` against `agent_memory` on the local Unix socket, port 5433. It reports only boolean readiness, embed model, pgvector version, row counts, minimum/maximum segment-vector dimension, and count of HNSW/IVFFlat indexes; no private memory text, credentials, or connection strings are emitted. Exit status is nonzero if the required host checks fail. This diagnostic is specific to the current Ubuntu deployment, not a portable generic memU diagnostic.

### Verified host result

- Private config and CLI executable: **available**.
- Database connection: **available**, pgvector **0.8.1**.
- memU records: one recall file, one recall-file segment, zero resources.
- Segment embedding dimensions: minimum and maximum **768**.
- HNSW / IVFFlat indexes in the memU schema: **zero**.

These checks establish **connectivity**, not correct tenant isolation, authorization to promote records, a successful same-scope semantic recall, end-to-end production readiness, or consistency of embedding provenance across future records.

## Opt-in retrieval contract

`memory/memu-runtime.mjs` strictly loads a regular, non-symlinked, owner-readable-only config of at most 8 KiB. It rejects group/other permissions, unexpected owner, duplicate or unknown keys, shell interpolation characters, cloud mode, nonlocal embedding endpoints, or model/provider drift. Approved binary and default config paths are fixed. The config is never evaluated as shell input, and its literal values enter only a direct non-shell memU child environment with narrowly scoped inherited variables.

`retrieveMemuMemory` defaults to the installed absolute CLI path. To activate the **private config path** for an already explicitly enabled retrieval operation, provision both `MEMU_RETRIEVAL_ENABLED=true` and `MEMU_RUNTIME_CONFIG_PATH=/home/bridge/.memu/config.env` through Bridge-owned service configuration after approval. Without the explicit runtime config path, the legacy injected binary/process environment behavior remains for test compatibility; no setting is added to the live unit here. With the config path, validation failures return empty recall rather than launch an untrusted subprocess. Unattributed/cross-scope memU hits remain rejected by `compactRecall`.

**Critical:** even with retrieval enabled, `jobs/preparation/local-task-preparation.mjs` still withholds recalled memory from the agent prompt. This PR does **not** grant a retrieved hit authority to dispatch, edit Factory Brain, update Git instructions, run commands or promote memory. Core memU retrieval does not implement Bridge tenant/agent/repository/issue authorization at the database-query layer; filtering after native retrieval is not independent DB-level isolation.

## Follow-up ABR-59 milestones

The next milestone must deliver authenticated scope-bound provenance/trust envelopes, exact issue/repository/agent/tenant storage separation and deterministic task-metadata query construction, sanitizer/redaction/expiry and safe opt-in prompt use. A later milestone must use a real GitHub/Linear-approved same-SHA proof, supported memU API/CLI payload, durable idempotency/retry journal, and isolated commit → cross-session scoped retrieval canary before production activation. There is no automatic promotion or memory-writing path in M1.

### Tests and rollback

`node --test memory/memu-runtime.test.mjs` covers private mode, ownership, symlinks, duplicate keys, nonlocal endpoints, untrusted commands, runtime opt-in, direct child environment, non-execution on failure, diagnostic sanitization and fixed read-only SQL. The same tests are included in `npm run bridge:test` and `npm run test:reliability`. The script's only mutable state is an operator-created temporary test fixture; it does not modify host config. To roll back, revert these source changes and leave `MEMU_RUNTIME_CONFIG_PATH` unset.
