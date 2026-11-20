# ABR-91 — Scoped Factory Brain (read-only M1)

This is a **read-only, operator-approved** first stage for Tier 2 Factory Brain. Canonical Git `AGENTS.md` and nearest-owner README/Context v1 remain primary instructions. Tier 1 checkpoints describe current issue progress; Tier 3 memU recall remains withheld. Factory Brain is **lower-trust reference data** and cannot authorize job transitions or rewrite repository instructions.

## Private storage and schema

Each repository uses a private `<repositoryRoot>/.linear-agent/factory-brain.json` file (directory mode 0700, file mode 0600). The root's existing local `.git/info/exclude` excludes `/.linear-agent/`. The file is not committed. Version 1 is a JSON object with `schemaVersion: 1`, increasing positive integer `revision`, `tenantId`, `agentId`, absolute canonical `repositoryRoot`, ISO UTC `updatedAt`, `expiresAt`, and `invariants` (up to 30 entries of `{id,source,text}`). Limit: 40,000 file bytes and 2,400 prompt characters.

The schema deliberately does **not** make an `approved: true` flag in the file authoritative. An operator must review the proposed content, its cited Git provenance and any changes, then independently calculate its exact SHA256 digest and pin that digest in trusted Bridge configuration. The loader never writes to the file, never updates `AGENTS.md`, and never turns a model-generated rule into approved memory.

## Approval configuration

`FACTORY_BRAIN_APPROVALS_JSON` is a JSON mapping of scoped key to approved file digest. The scope key is `sha256(JSON.stringify([tenantId, agentId, canonicalRepositoryRoot]))`, exposed as `factoryBrainScopeKey()`. Example configuration shape (the keys and hashes below are placeholders, not approvals):

`{"<scope-sha256>":"<reviewed-file-sha256>"}`

Only exact scope and exact file digest match. Files with expired timestamps, mismatched version/scope, insecure mode, symlink, oversized content, or an unapproved revision are ignored. A hash pin is a **review procedure**, not a cryptographic proof that a human approved the content; approval must occur outside the agent-controlled file. Never let an agent modify the operator's configuration. If configuration or backend is missing, local admission still operates with authoritative Git instructions and Tier 1 recovery.

## Integration and tests

`jobs/preparation/local-task-preparation.mjs` loads this reference at each local admission (new and resumed tasks), before persisting the canonical routed prompt. It does not change ledger authority or the normal single task-file write. Quoted bounded references are wrapped with explicit lower-trust markers. This is not an MCP tool and provides **no memory-write API**. A native-vs-authenticated-MCP parity test and PostgreSQL storage decision remain subsequent work.

Run `node --test memory/factory-brain.test.mjs`; it covers same-scope load, resumption, cross-agent/tenant/repo isolation, digest/revision/expiry rejection, private mode, symlink refusal, budget bounds and failed backend behavior. Both bridge and reliability suites include this test.

## Rollout and rollback

No production activation is included. To enable later, a separate operator review must provision the private file for each authorized repository/agent, pin the approved SHA256 in the Bridge service environment, test a nonproduction local dispatch, and explicitly approve service rollout. Roll back by removing its scoped approval entry; the code then ignores the file. Neither action requires a database migration.

The currently existing `memory/migrations/001_agent_checkpoints.sql` is checkpoint-only; no live `memory.factory_brain` table contract is established. No database DDL/backfill is part of M1. A PostgreSQL backend, multi-host MCP delivery, verified approval workflow, and anti-rollback revision registry require separate design and review.
