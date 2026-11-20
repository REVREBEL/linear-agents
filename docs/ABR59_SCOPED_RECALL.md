# ABR-59 M2 — Trusted-source recall reference boundary

This milestone introduces a **default-off** structured recall reference interface, not automatic prompt injection or storage-level tenant authorization. The existing core memU retrieve CLI can return segments, files, and resources, but it has no independently authenticated Bridge tenant/agent/repository/issue query filter. User/model-supplied metadata is therefore **not** trusted evidence of provenance.

## Contract

The memory/scoped-recall.mjs module validates four exact scope identifiers, a full 40-character source Git SHA, a safe repository-relative source path, positive source revision, finite future expiry, bounded content and a SHA-256 digest. The digest must belong to a **separate, independently reviewed Bridge-owned allowlist**; it cannot come from a memU hit, MCP tool result, README, agent response, or fabricated review. The digest includes content, scope, source SHA, path, revision and expiry, so any change invalidates approval. A missing digest set skips candidate processing, and the opt-in retrieveMemuMemory returnEnvelope mode does not even start a CLI subprocess without a nonempty approved digest set.

Returned references carry trust: untrusted-reference-only, exact source attribution and no executable authority. The sanitizer drops known credential patterns, high-risk directives, control characters, expired, mismatched and duplicate records. It bounds individual text to 600 characters, top-k to five and combined content to 2,500 UTF-8 bytes. These are **bounded heuristic checks**, not comprehensive prompt-injection or secret detection. Memory is always data; it cannot authorize tools, commands, worker routing, changes to AGENTS.md, Factory Brain writes or memory promotion.

The legacy compactRecall compatibility path still only checks claimed metadata and remains disabled by default. The new opt-in envelope path requires independent digest approval; neither the native memU command nor older metadata checks provide a database-level row-security guarantee. Do not enable prompt injection or use this endpoint as a multi-tenant security boundary. PostgreSQL roles/namespace constraints, verified approval storage and read-time authorization must be implemented and audited separately.

## Task context ownership

jobs/preparation/local-task-preparation.mjs now builds the optional retrieval query only from trusted route repository root, issue ID and the fixed coding task type. Unusable values result in **no retrieval request**. It continues to withhold *all* recalled text from agent prompts, even from an independently digested envelope. The source Git instruction bundle, README resolver, job ledger and approval gate remain independently authoritative.

## Tests and remaining release gates

Run node --test memory/scoped-recall.test.mjs for independently pinned digests, tampering, foreign tenant/agent/repository/issue, wrong commit or revision, stale records, known prompt-injection attempts, common credential patterns, bounded output, duplicate suppression, native memU segment text and prevention of subprocess dispatch without approved digests. The focused tests are registered in both bridge and reliability suites.

Remaining ABR-59 work: Bridge-owned authenticated digest/approval persistence and loading; storage-level tenant/repository/issue separation; comprehensive sanitizer/provenance auditing; real verified memU commit and cross-session read canary; idempotent promotion journal and crash recovery; and explicit opt-in prompt/memory integration with native-versus-authenticated-MCP parity. No production service, database, model, credentials, or live memory records are changed by M2. Revert M2 code and leave all default-off settings unset to roll back.
