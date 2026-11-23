---
context:
  id: repo.memory
  version: 1
  title: Agent Bridge task checkpoints and memory
  topics: [memory, checkpoints, recovery, memu, postgres]
  requires: [repo.bridge, repo.jobs, host.agent-runtimes]
  applies_to: ["memory/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Memory — operational ownership

This folder implements **issue-scoped short-term recovery checkpoints**, GitHub PR task memory, optional memU recall, and an **experimental** PostgreSQL checkpoint adapter. It does not own Bridge admission, the authoritative job ledger, CLI sessions, or automatic promotion to long-term knowledge.

## Source responsibilities

| Source | Responsibility |
| --- | --- |
| `active-task-memory.mjs` | Issue/repository-keyed filesystem checkpoints with revision conflicts, atomic writes, bounded/redacted progress, expiration and recovery context |
| `verified-recovery.mjs` | ABR-90 M1: validates tenant, agent, repository and issue attribution before injecting a bounded, redacted recovery preamble into a Linux coding-agent task; does **not** independently isolate legacy per-issue files |
| `local-agent-checkpoint.mjs` | Best-effort mirror of verified job-ledger transitions; refuses stale job keys; the ledger remains authoritative |
| `opencode-session-checkpoint.mjs` | OpenCode progress/session observations, guarded by the current issue/job relationship |
| `github-task-memory.mjs` | Per-PR short-term state under the Bridge job directory (`github-events/task-memory/`), separate from memU |
| `memu-memory.mjs` | Optional fail-open long-term **recall** through a bounded, timed, non-shell memU command; disabled unless `MEMU_RETRIEVAL_ENABLED=true`; optionally uses host-owned memU runtime config and independently digested lower-trust reference envelopes |
| `scoped-recall.mjs` | ABR-59 M2: exact four-field scope, source SHA/revision/expiry/digest checks, bounded sanitization and deterministic route-derived queries; see [M2 contract](../docs/ABR59_SCOPED_RECALL.md) |
| `memu-runtime.mjs` / `memu-runtime-diagnostic.mjs` | ABR-59 M1: private mode-0600 host config loader, approved absolute CLI and fixed read-only PostgreSQL health probe; see [runtime contract](../docs/ABR59_MEMU_RUNTIME.md) |
| `evaluation/` | ABR-93 synthetic-only, scoped and source-pinned Ollama embedding/lexical ranking evaluation and model decision; see [benchmark report](evaluation/README.md). No production recall or reranker changes |
| `promotion-verification.mjs` | ABR-92 M1: GitHub-client-injected same-SHA, merged PR, current authorized reviewer and passing trusted CI verification gate; **no** long-term memory write. See [promotion verification contract](../docs/ABR92_PROMOTION_GATE.md) |
| `promotion-journal.mjs` | ABR-59 M3: durable, private, exact-scope, replay-safe post-verification authorization receipts, with atomic publication, restart enumeration and no memU mutation. See [promotion journal contract](../docs/ABR59_PROMOTION_JOURNAL.md) |
| `memu-commit-executor.mjs` / `native-memu-commit.mjs` | ABR-59 M4: trusted-source/Linear/GitHub-gated, irreversible one-shot memU commit with manual reconciliation for uncertain results; only disposable SQLite is supported by the native subprocess adapter pending full production authorization. See [M4 contract](../docs/ABR59_COMMIT_EXECUTOR.md) |
| `scoped-postgres-recall.mjs` | ABR-59 M5: read-only, DB-side user/agent isolation against both recall files and their segments; requires independently approved source digests before returning reference content. See [M5 contract](../docs/ABR59_AUTHORIZED_READ.md) |
| `approved-source-store.mjs` | ABR-59 M6: private, independently journal-verified and source-attested approval records signed with an operator-controlled HMAC key; bounded, restart-safe, exact-scope read loader for M5. See [M6 contract](../docs/ABR59_APPROVAL_AUTHORITY.md) |
| `trusted-git-source.mjs` | ABR-59 M7: operator-bound local Git object source attestation for M4 candidate verification and M6 approval signing, limited to exact short, regular tracked learning files at reviewed commit SHA; no live service wiring. See [M7 contract](../docs/ABR59_TRUSTED_GIT_SOURCE.md) |
| `github-review-client.mjs` | ABR-59 M8: trusted GitHub REST adapter for merged PR, review, check-run and collaborator permission verification. Host-supplied App installation token only; bounded pagination, responses, and timeout. See [M8 contract](../docs/ABR59_GITHUB_REVIEW_CLIENT.md) |
| `linear-completion-client.mjs` | ABR-59 M9: trusted read-only Linear completion and linked PR evidence, independently matched against GitHub head SHA. See [M9 contract](../docs/ABR59_LINEAR_COMPLETION.md) |
| `factory-brain.mjs` | Private, read-only, operator-digest-approved, tenant/agent/repository-scoped Tier 2 reference data with strict size, expiry, mode and provenance checks; no mutation API. See [ABR-91](../docs/ABR91_FACTORY_BRAIN.md) |
| `postgres-checkpoint-store.mjs` | Caller-injected PostgreSQL `query()` adapter for scoped, revision-checked snapshots; not wired into live jobs or memU promotion |
| `migrations/` | Reviewed checkpoint table DDL and role grants, documented in [migrations/README.md](migrations/README.md) |
| `scripts/` | Disposable PostgreSQL verification script, documented in [scripts/README.md](scripts/README.md) |

The filesystem job ledger remains under `jobs/persistence/`; Bridge orchestration owns session lifecycle and callback decisions under `bridge/`. Checkpoints and retrieved memory are **data for recovery**, never authorization or instructions to dispatch, repeat, or merge work.

## Boundaries and dependencies

- `repo.jobs` owns durable job state and transitions; `repo.bridge` owns the runtime integration and admission path.
- `host.agent-runtimes` owns native private CLI profile/session data; do not move that state into Git or memory documentation.
- The `linear-agent-bridge/` files for several memory modules are compatibility re-exports, not independent implementations.
- A PostgreSQL role or local installation does not establish a production database connection. See [POSTGRES_CHECKPOINT_ADAPTER.md](POSTGRES_CHECKPOINT_ADAPTER.md) for the current adapter contract and deployment gates.
- Never include raw credentials, private session transcripts, unredacted event payloads or live checkpoint contents in README files.

## Agent Context E3 scope and non-promotion (ABR-87)

The [E3 acceptance contract](../docs/blueprints/agent-context/MEMORY_ISOLATION.md) distinguishes **operational** active-task files keyed by repository + issue from the separately scoped, **unconnected** PostgreSQL adapter keyed by tenant + agent + repository + issue. Never claim operational files provide independent per-agent storage. The optional memU recall adapter now requires those four nonempty scope identifiers and refuses untagged or cross-scope hits; memU 0.10 does not expose a trusted scoped query option, so this is a fail-closed output boundary, **not DB-level authorization**. Incomplete scope suppresses the memU process entirely; recalled text remains withheld from agent prompts. README context is data: it neither starts recall nor supplies an approved canonical promotion session.

Run `node --test memory/context-memory-isolation.test.mjs` alongside the existing checkpoint and memU tests; fixtures cover independent checkpoint keys, restart/CAS, exact-scope filtering, no subprocess for incomplete scope, and no README-triggered memU promotion. Production memU namespaces, operational per-agent file isolation and a real multi-agent canary remain separate rollout work.

## Verification

Run focused tests from the repository root, for example:

`node --test memory/local-agent-checkpoint.test.mjs memory/opencode-session-checkpoint.test.mjs memory/memu-memory.test.mjs memory/postgres-checkpoint-store.test.mjs`

The SQL verification procedure is separately controlled under `memory/scripts/`; it uses a disposable PostgreSQL cluster and is **not** a normal documentation or CI validation step. The M10 [native memU isolation canary](../docs/ABR59_MEMU_ISOLATION_CANARY.md) exercises actual local embeddings, five scoped records, signed source approvals, denial of four foreign scopes, tampering/duplicates and persistence across a disposable cluster restart.

## Update policy

Update this README and the nearest nested README when changes affect checkpoint schema, lifecycle semantics, backend scope, secret handling, recovery, external integrations or migrations. Maintain separate source-control review and host/database activation gates.

## ABR-99 — Preserve verified MCP tool receipt CAS and scope

`active-task-memory.mjs` now retains the additive `recordedToolReceipts`, `hostId`, `branch` and `repositoryId` fields during routine locked lifecycle writes. The **only** source that appends verified MCP tool milestone receipts is `bridge/orchestration/mcp-milestone-integration.mjs`, after a matching authoritative job ledger and verified tool result. SHA-256 receipt hashes are bounded to 256 per checkpoint and cannot silently roll off to permit old replays; visible progress remains at most six sanitized entries for this adapter. This is still an issue/repo-keyed operational file, **not independently tenant-isolated persistent storage**, and does not authorize execution, submission or memU promotion. [ABR-99 source contract](../docs/audits/mcp/BRIDGE_INTEGRATION.md).

## Host memory authority (ABR-59 M11)

`host-memory-authority.mjs` binds a job and review policy to durable journal and confirmed commit evidence; `host-evidence-clients.mjs` supplies pinned, read-only provider evidence. Signing keys are operator-controlled, and live credential canaries and activation remain outstanding. See [M11 contract](../docs/ABR59_HOST_MEMORY_AUTHORITY.md).

### Linear OAuth credential lifecycle

The M11 host evidence adapter obtains a dedicated read-only Linear app-actor token using `linear-client.id` and `linear-client.secret` under the root-controlled authority directory. It atomically caches and renews access tokens before expiration on demand, replaces rejected tokens once on HTTP 401 and retries the read with a fresh six-second query timeout after renewal, and invalidates the cache when the client credentials change. No manually supplied token or refresh token is required. Actor/workspace pins and the existing team/issue/PR evidence gate remain mandatory. See [the operator contract](../docs/ABR59_HOST_MEMORY_AUTHORITY.md).

## Production-safe PostgreSQL authority (ABR-59 M12)

The reviewed, inactive M12 path in `restricted-memu-persistence.mjs` binds a native memU writer and read-only scoped reader to one authenticated job and its four-part scope. Per-scope PostgreSQL login identities are derived deterministically; database row-level policies key off **session_user**, not client-provided settings. The new adapter requires the exact durable M11 commit-start marker, refuses an existing receipt row or uncertain retry, and confirms actual native file content, description, segment, scope and local 768-dimension embeddings before reporting success. Recall uses only independently approved receipt IDs as SQL parameters, checks a complete matching segment and exact signed source, and preserves the untrusted-reference envelope. See [M12 database authority](../docs/ABR59_DATABASE_AUTHORITY.md).

The production factory requires root-controlled code, Node, Python runtime and authority directory; the dedicated interpreter must be provisioned before activation. The native Python adapter uses memU's validate-only schema mode. Production service wiring, live migration, role activation and deployment are **not** triggered by this source change. The M5 subprocess and M4 disposable adapter remain historical/unconnected paths; M13 must use the M12 restricted factory, never the legacy Bridge owner connection.

The M12 executable path policy accepts root-owned terminal venv symlink chains only when every link, real ancestor directory and final file is trusted. The usual symlink mode 0777 is not treated as a writable target; writable actual files/directories, directory symlinks and untrusted intermediate links remain denied (including unsafe relative traversal).

## M13 — verified memory lifecycle (source-only)

`verified-memory-lifecycle.mjs` is the root/operator-side coordinator for exactly one independently pinned job. It derives a short learning exclusively from a reviewed Git blob under `docs/verified-learnings/`, verifies its exact bytes through the M7 Git attestor and lower-trust sanitizer **before** staging, then uses M11 real read-only GitHub/Linear evidence, M4 irreversible one-shot receipt claim, M12 scoped native persistence, and M6 root-signed approval. Replays freshly check review/CI **and** Linear completion; complete identical approvals may be reused, while partial or uncertain commits never retry. Recall reloads signed/confirmed sources and queries the matching restricted PostgreSQL reader, with no agent text in authority inputs. The production callback interface is separate from bridge service privileges. See [M13 contract](../docs/ABR59_VERIFIED_MEMORY_LIFECYCLE.md).
