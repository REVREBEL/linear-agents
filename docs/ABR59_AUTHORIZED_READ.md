# ABR-59 M5 — Read-only authorized PostgreSQL memory recall

This milestone adds a **separate, default-unwired** read path that enforces native memU's two supported scope fields at the **SQL query boundary**, before retrieving any memory contents. The installed core memU 0.10 CLI's native `retrieve` operation performs an unscoped search; do **not** use it for authenticated multi-agent memory retrieval.

## Storage and authorization contract

Read against the installed `agent_memory` PostgreSQL database on the local Unix socket, port 5433. Native memU stores `user_id` and `agent_id` in both `memu.recall_files` and `memu.recall_file_segments`. M4 writes deterministic `user_id = SHA256(JSON.stringify([tenantId,repositoryId,issueId]))`, with the selected agent as `agent_id`. M5 reuses the **same helper** for writes and reads to avoid diverging identity derivation.

The fixed `BEGIN READ ONLY` SQL filters the parent file by both user and agent, `track='memory'`, deterministic `bridge-<64-hex>` receipt filename, bounded content, and an `EXISTS` requirement for a matching child segment's user/agent/track. Identifiers enter only through psql's quoted `:'scoped_user_id'` and `:'scoped_agent_id'` parameters; no model-generated or untrusted SQL is accepted. Output is bounded to 100 rows and 128 KiB; the process has a 5-second timeout and drains redacted stderr. The SQL runs under the Bridge OS account; no user-supplied database endpoint or arbitrary role is supported.

The returned native records are **not by themselves trusted**. Every result must also exactly match a separately Bridge-approved source record keyed to its deterministic receipt ID, including byte-identical content and the four-field scope. The existing `verifiedRecallEnvelope` subsequently requires an independently approved source digest, valid Git SHA, path, revision, non-expired provenance, bounded text and sanitizer. Missing approval material prevents even launching the database query. The output is reference data only (`trust='untrusted-reference-only'`) and cannot authorize tools, commands or memory promotion. The public API is `readScopedMemuFiles({scope,approvedSources,trustedDigests})`, but **neither approval loader nor agent prompt injection is wired**.

This is **application-level SQL filtering**, not PostgreSQL RLS, immutable source approval authority or complete resistance to hostile memory records. The Bridge service account still has broader database privileges than a tenant-specific account. The existing unscoped `retrieveMemuMemory` compatibility adapter remains disabled by default and continues to withhold recalled material from agent prompts. Production activation requires authenticated approval storage and RLS/least-privilege review, real multi-scope canaries and security review.

## Verification

- Unit tests cover matching M4/M5 identity derivation, parent-and-child DB filters, SQL argument boundaries, approved and altered content, foreign scope, missing digests, malformed result handling and no subprocess launch on authorization failure.
- Run `node --test memory/scoped-postgres-recall.test.mjs`, `npm run bridge:test`, and `npm run test:reliability`.
- On the Ubuntu server, `node scripts/check-scoped-memu-read.mjs` as the Bridge OS account uses a reserved synthetic tenant/agent/issue and reads only; expected JSON: `{"readOnly":true,"approvedRecordsReturned":0,"databaseScopeVerified":false}`. The empty approved envelope is a connectivity and filtering smoke check: rejected database rows are invisible to it, so it cannot prove SQL isolation. A separate multi-scope canary with positive and negative controls is required. It never writes to PostgreSQL, changes service state or prints memory contents.

The next milestone requires trusted digest authority persistence and host adapters, actual multi-tenant isolated read/write canaries and a carefully reviewed explicit production opt-in. No live memory content is promoted, exposed to an agent or modified in M5.
