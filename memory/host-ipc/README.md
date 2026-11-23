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
