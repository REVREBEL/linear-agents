---
context:
  id: repo.memory.scripts
  version: 1
  title: Isolated checkpoint database verification
  topics: [memory, postgres, testing, scripts]
  requires: [repo.memory, repo.memory.migrations]
  applies_to: ["memory/scripts/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Checkpoint verification scripts

This directory owns **explicitly invoked test harnesses** for the experimental PostgreSQL checkpoint adapter; it is not an application runtime launcher.

`verify-postgres-checkpoints.sh` creates a disposable **PostgreSQL 18** cluster beneath `/tmp`, uses test port `55439`, applies [`../migrations/001_agent_checkpoints.sql`](../migrations/001_agent_checkpoints.sql), checks revision advancement, scoped records and restricted role privileges, then cleans up the temporary cluster.

## Execution boundary

The script invokes `initdb`, `pg_ctl` and `psql` and requires authorized local `postgres` OS access. It checks for a busy test port. This is an **explicit, stateful integration test** and must not run during context discovery, general README validation, or an unapproved production migration. It does not establish that the installed application PostgreSQL instance is configured or safe for production use.

See [`../POSTGRES_CHECKPOINT_ADAPTER.md`](../POSTGRES_CHECKPOINT_ADAPTER.md) for the experimental adapter's current gates. Do not change the test database target to an existing service.

## Maintenance

Review updates to the script alongside the SQL migration, checkpoint adapter and focused tests. Do not embed credentials or copy real database snapshots into this folder.

Context ID: `repo.memory.scripts`; dependencies: `repo.memory` and `repo.memory.migrations`.
