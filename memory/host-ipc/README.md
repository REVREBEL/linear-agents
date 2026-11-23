# M14 verified-memory host boundary

This directory is a **source-only** review artifact until explicit operator activation under [M14](../../docs/ABR59_M14_ACTIVATION.md). It must never be invoked from a mutable coding-agent checkout as root.

- `authority-server.py` is the root-owned Linux AF_UNIX server, requiring an exact systemd MainPID and start-time pin plus a fully trusted executable release. It accepts one bounded request and never trusts a shared `bridge` UID or a caller-supplied PR, source, repository mapping or scope.
- `verified-memory-host.mjs` is a standalone, credential-free Node Bridge client intended for installation by the operator at `/etc/agent-bridge/verified-memory-host.mjs`.
- `activation-contract.mjs` and `operator-worker.mjs` recheck each root-pinned job and release SHA before invoking the M13 signed approval and M12 restricted PostgreSQL adapter.
- `activation.example.json` has `activation:false`, dummy identities and no secrets. The live root-owned manifest must be reviewed and created separately.
- `verified-memory-authority.service` is a non-deployed systemd example for operator review.
- `readiness.py` is a read-only live host gate reporter that never enables a service or certifies acceptance from synthetic fixtures.
- `test_authority_server.py`, `test_readiness.py`, `activation-contract.test.mjs` and `verified-memory-host.test.mjs` exercise fixed protocol, identity isolation, malicious inputs and default-denied behavior.

Run the Python and Node offline tests as described in the M14 contract. The separate M12/M13 disposable PostgreSQL canary proves native persistence and new-process recall without using the production DB or any live app secrets.

## M14 review hardening

The source-only authority additionally requires fully root-owned and clean Git checkouts for the authority modules and for each separately pinned approved learning repository (`integrity.py`), live canonical admission matching the durable job ledger and the retained task (`admission.py` / `admitted-canonical-job.mjs`), and an exact raw manifest digest bound between IPC admission and privileged worker. The server verifies all dependencies before loading local Python modules; the Node worker uses dynamic imports only after sealing its complete executable checkout.

`intent.py` persists and fsyncs completion hints before acknowledgment, blocks automatic ambiguous retries, and marks queued/running records as requiring operator reconciliation on restart. `db-gate.sql` checks the exact PostgreSQL 18 policy fingerprints, role grants and approved per-scope login mappings; `verify-db-gate-fixture.py` tests authorized and unauthorized grants against an isolated cluster. The active systemd unit uses `ProtectHome=read-only` only to inspect canonical Bridge job evidence, never to write agent files. Live service health, changed Bridge PID/release, stale sockets and incorrect unit/sandbox settings all cause readiness failure.

See [M14 controlled rollout](../../docs/ABR59_M14_ACTIVATION.md) for the separate operator and production canary gates.

## M14 production readiness corrections

`db-gate.sql` explicitly selects `search_path=memu,public` to make five
PostgreSQL 18 policy fingerprints invariant to the live session's default
schema path. The native policies remain unchanged. The operator unit allows
**only CAP_DAC_READ_SEARCH** to read the Bridge-owned mode-0600 canonical job
ledger under `ProtectHome=read-only`; it retains `NoNewPrivileges=true` and
does not grant CAP_DAC_OVERRIDE or any right to modify agent-owned job data.

The live authority readiness audit reads the actual running
`/proc/<MainPID>/status`, requiring `CapEff`, `CapPrm` and `CapBnd` to
contain only `CAP_DAC_READ_SEARCH` (bit 2). Updating the unit file without
restarting the active authority cannot satisfy this gate. The sealed Bridge
unit must retain the canonical name `agent-bridge.service` for peer
authentication and PID/start-time validation.
