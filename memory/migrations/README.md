---
context:
  id: repo.memory.migrations
  version: 1
  title: PostgreSQL agent checkpoint migrations
  topics: [memory, postgres, migrations, schema]
  requires: [repo.memory]
  applies_to: ["memory/migrations/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Checkpoint database migrations

This directory owns **reviewed SQL definitions**, not live PostgreSQL runtime data or migration authority.

`001_agent_checkpoints.sql` creates the `memory` schema and `memory.agent_checkpoints` table, keyed by `tenant_id`, `agent_id`, `repository_id` and `issue_id`. It grants the restricted `agent_memory_app` role schema usage and table SELECT/INSERT/UPDATE only. The adapter in [`../postgres-checkpoint-store.mjs`](../postgres-checkpoint-store.mjs) requires caller-provided database access and atomic revision checks.

## Ownership boundaries

Only run approved migrations against the intended dedicated `agent_memory` database using an authorized migration role. The SQL file is **not** executed automatically by the Bridge or by context resolution. Do not apply it to `wikijs_db`, `n8n_db`, or the default `postgres` database.

An SQL schema version or a migration file's presence is not proof of live DB connectivity, application-side tenant authorization or row-level isolation.

## Verification and change discipline

See [`../POSTGRES_CHECKPOINT_ADAPTER.md`](../POSTGRES_CHECKPOINT_ADAPTER.md) and [`../scripts/README.md`](../scripts/README.md) before running the isolated test fixture. Update tests, adapter expectations and reviewed migration procedures together when changing columns, permissions, revision semantics or isolation boundaries.

Context ID: `repo.memory.migrations`, dependent on `repo.memory`.

## ABR-59 M12 — native memU authority

- `002_memu_scope_authority.sql` is an explicitly approved, transactional maintenance migration for the audited native memU schema. It requires a quiesced dedicated database and privileged operator, rejects unexpected grants/objects/schema revision, transfers native table/schema ownership from the legacy role to the database operator, creates locked group roles and a private scope mapping, and applies forced RLS and parent-scope constraints. It preserves legacy rows but does not expose them to the restricted application roles.
- `003_memu_scope_login.sql` provisions separate deterministic reader and writer roles initially **NOLOGIN**, with immutable scope mapping and no inherited administrative rights or SET ROLE membership. The operator installs the corresponding root-only peer mappings before enabling each login.
- `004_memu_scope_disable.sql` is a fail-closed operational rollback: disable scope logins, terminate sessions and revoke restricted grants; never restore the agent's old owner rights or delete memory.

Do not apply these scripts automatically or against unrelated databases. Follow [the production rollout and rollback plan](../../docs/ABR59_DATABASE_AUTHORITY.md) and [the disposable verification harness](../scripts/README.md).

The M12 migration intentionally holds ACCESS EXCLUSIVE locks until transaction end, blocking all reads and writes on the four native memU tables. Both non-concurrent unique index builds scan existing file rows; the NOT VALID composite foreign key takes locks but skips validation of existing segments. Schedule an approved maintenance outage and rehearse against a representative isolated restored database; keep atomic rollback and bounded lock/statement timeouts.
