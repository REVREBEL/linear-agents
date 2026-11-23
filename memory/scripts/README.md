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

`verify-memu-isolation.sh` and `memu-isolation-canary.mjs` run the ABR-59 M10 native memU integration canary as the bridge OS user. A private Unix-socket-only PostgreSQL 18 cluster under `/var/tmp` stores synthetic memories in five scopes, then restarts and verifies recall and denial behavior again. No production database is used. See [M10 host acceptance](../../docs/ABR59_MEMU_ISOLATION_CANARY.md).

## Execution boundary

The script invokes `initdb`, `pg_ctl` and `psql` and requires authorized local `postgres` OS access. It checks for a busy test port. This is an **explicit, stateful integration test** and must not run during context discovery, general README validation, or an unapproved production migration. It does not establish that the installed application PostgreSQL instance is configured or safe for production use.

See [`../POSTGRES_CHECKPOINT_ADAPTER.md`](../POSTGRES_CHECKPOINT_ADAPTER.md) for the experimental adapter's current gates. Do not change the test database target to an existing service.

## Maintenance

Review updates to the script alongside the SQL migration, checkpoint adapter and focused tests. Do not embed credentials or copy real database snapshots into this folder.

Context ID: `repo.memory.scripts`; dependencies: `repo.memory` and `repo.memory.migrations`.

## Host authority controls (ABR-59 M11)

`manage-host-authority-key.py` is a root-only operator command for key initialization, rotation, and revocation. `verify-host-evidence.mjs` performs the separately configured read-only evidence canary; credentials and live canary acceptance remain operator gates. See [M11 contract](../../docs/ABR59_HOST_MEMORY_AUTHORITY.md).

The root-only `discover-linear-oauth-identity.mjs WORKSPACE_UUID` bootstrap reports the candidate app actor and workspace UUIDs for operator pinning, without printing or persisting access tokens. The evidence canary uses the dedicated client credential files and may create or renew its private token cache; neither command enables the running Bridge service or writes to Linear or memU.

## M11 operator canary runbook (ABR-101)

Run the evidence scripts from a reviewed, root-owned checkout whose ancestors
and source files cannot be changed by agent accounts. On the Ubuntu host the
dedicated checkout is `/var/lib/bridge-memory-authority-code`; credential and
state files remain separately under `/var/lib/bridge-memory-authority`.
Do not execute the Bridge service's agent-writable checkout as root with
authority credentials.

1. Verify the operator checkout contains the reviewed merge of the OAuth
   lifecycle change; update the private checkout only to reviewed commits.
2. As root, run `node memory/scripts/discover-linear-oauth-identity.mjs WORKSPACE_UUID`
   from that checkout. Use the independently known workspace UUID. Confirm
   the returned actor belongs to the dedicated app before pinning the actor ID.
   The discovery output contains identity metadata, not the token.
3. Create mode-0600, root-owned `evidence.json` in the credential directory
   with the actual numeric GitHub app ID, installation ID and repository ID,
   the repository full name, and the Linear workspace, actor and team UUIDs.
   See the [operator contract](../../docs/ABR59_HOST_MEMORY_AUTHORITY.md)
   for the exact field names. Use the dedicated app's installation, not
   another connector's installation.
4. Select a genuinely completed issue with a linked merged PR. Pin the full
   reviewed head SHA, the exact job scope and a distinct reviewer with current
   write, maintain or admin repository permission in `canary.json`. An
   automated review with no collaborator permission is insufficient.
   Pin the operator-approved relevant CI checks and trusted app slugs before
   running acceptance. If branch rules provide no required status checks,
   explicitly approve the policy for the canary rather than inferring it from
   successful runs or reducing it after a failure.
5. From the private code checkout run
   `node memory/scripts/verify-host-evidence.mjs`. A passing result verifies
   read-only evidence, not production database or service activation.

A `MODULE_NOT_FOUND` for the relative script means the current directory
is incorrect or the reviewed source is not installed. A denial at
`operator-canary-config` indicates missing, unreadable or malformed canary
configuration; it occurs before external evidence requests. A denial at
`pinned-evidence-provider` indicates the pinned evidence configuration was
not accepted. Later GitHub and Linear stages require successful provider
authentication and the actual independently verified review, check, issue and
attachment evidence. Keep secrets out of console output, issue comments and
Git; do not weaken verification to obtain a passing result.

## Restricted native PostgreSQL canary (ABR-59 M12)

`verify-memu-restricted-db.sh` runs as the bridge OS account against a fresh Unix-socket-only PostgreSQL 18 cluster, and uses distinct **authenticated** non-owner reader/writer logins rather than SET ROLE from a privileged connection. It bootstraps the native memU schema, reproduces the audited legacy owner layout, applies the M12 migration and provisions five independent scope pairs. The native adapter uses local Ollama embeddings and memU validate-only mode. It exercises raw SQL isolation, signed approved-ID recall, denied writes and privilege escalation, uncertain partial commits, restart, logical backup/restore and fail-closed disable/row preservation. All review/issue records are synthetic; production data and services are not used. Invoke from a reviewed worktree as bridge; the script owns and cleans only its private test directories. `restricted-memu-native.py` is the bounded native implementation called from the M12 host factory, not a general-purpose CLI or an agent tool.

The native preflight identifies each database privilege and group-membership result by its SQL alias, requiring mutually exclusive reader/writer membership, and safe membership flags for both. The disposable canary exercises real writer commits and reader recalls and denies unexpected additional group membership.

## M13 combined native integration

The M12 disposable PostgreSQL acceptance harness additionally runs M13's operator-pinned promotion pipeline in the same private, already-restarted cluster. A fixture reviewed GitHub PR and completed Linear issue permit one native memU commit and signed approval; an entirely new Node process then reads the actual restricted PostgreSQL record using signed evidence. Review revocation, a reopened issue, foreign scope and duplicate promotion all deny. `memu-m13-recall-child.mjs` is an isolated fixture, not a production runnable memory service. Backup/restore and rollback then verify the extra approved native file remains intact.

## M14 operator readiness

`memory/host-ipc/readiness.py` audits the current host's root custody, immutable checkout, sealed Python runtime, protected Bridge client/socket, scoped DB RLS/role state, private activation manifest, service unit, trusted release, and independently recorded live canary. It performs read-only metadata checks and reports redacted booleans. `host-ipc/test_*.py` and `host-ipc/*.test.mjs` cover bounded protocol, kernel process identity, scope and job allowlists, and standalone client. Operational approval and rollback are described in [M14](../../docs/ABR59_M14_ACTIVATION.md).
