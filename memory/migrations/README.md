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
