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
| `memu-memory.mjs` | Optional fail-open long-term **recall** through a bounded, timed, non-shell memU command; disabled unless `MEMU_RETRIEVAL_ENABLED=true` |
| `promotion-verification.mjs` | ABR-92 M1: GitHub-client-injected same-SHA, merged PR, current authorized reviewer and passing trusted CI verification gate; **no** long-term memory write. See [promotion verification contract](../docs/ABR92_PROMOTION_GATE.md) |
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

The SQL verification procedure is separately controlled under `memory/scripts/`; it uses a disposable PostgreSQL cluster and is **not** a normal documentation or CI validation step.

## Update policy

Update this README and the nearest nested README when changes affect checkpoint schema, lifecycle semantics, backend scope, secret handling, recovery, external integrations or migrations. Maintain separate source-control review and host/database activation gates.
