# ABR-59 M14 — Operator-only production activation

## State and authorization

**Source-ready, not activated.** This revision adds a bounded, root-owned Unix IPC authority server, a no-secret Bridge client, root-pinned job/PR/source mapping, and read-only readiness reporting. It creates no privileged running process, database role, migration or production activation. M14 requires explicit operator approval for production credentials, database changes and service activation. The earlier M11 read-only credential canary is not a live M14 memory-write acceptance.

Read-only host audit on November 22, 2026: active `agent-bridge.service` runs as `bridge`, but both `/home/bridge/agent-bridge` and its legacy runtime subdirectory are bridge-writable. The native memU tables are still bridge-owned without RLS; no root-only Python runtime, protected memory client, IPC socket, unit or approved M14 activation manifest exists. Root-only M11 authority state and reviewed checkout do exist.

## Isolation and protocol

The Bridge and its child coding agents share Unix uid `bridge`. Socket group permission alone **cannot** distinguish them. The Python server uses kernel `SO_PEERCRED` to verify the **exact systemd MainPID**, OS uid/gid, PID start ticks, expected `agent-bridge.service` cgroup and immutable, root-owned release entrypoint with all non-writable ancestor directories. Same-uid CLI children, foreign processes, stale PIDs, agent-writable executable paths and unapproved code revisions are denied. Each connection reloads the root-private manifest; activation requires an explicit true gate and exact Git release SHA.

The sole proposed socket is `/run/bridge-memory-authority/bridge.sock` (root:bridge mode 0660 inside root-owned 0750). The standalone client to be copied to `/etc/agent-bridge/verified-memory-host.mjs` imports only Node's built-in `net` module and uses that fixed local endpoint. It has no PEM, OAuth, DB credentials, shell escape or arbitrary URL. No Bridge HTTP endpoint or agent runtime command is introduced.

Requests are one bounded JSON line (2 KiB) with only these operations:

- **repo:** maps a preapproved local repository root to an independently pinned canonical GitHub repository ID.
- **recall:** requires the exact tenant, agent, canonical repo, issue and durable job key for **one** root-approved record. The operator worker loads the root-signed approval, exact confirmed native receipt, scoped restricted DB reader, and matching source.
- **complete:** one advisory issue completion hint. Only an independently pinned issue may match; a root worker separately checks fresh GitHub review/CI, Linear completion and Git provenance before any one-shot commit. An accepted hint is **not** a claim that promotion succeeded.

The root worker accepts an operation, fixed job key and SHA-256 digest of the exact manifest snapshot. It independently verifies the canonical live Bridge admission, reloads the manifest, validates the authority Git SHA and separately pinned source-repository checkout SHA, and invokes M13 with no caller-selected policy, source, PR or credentials. Any partial/uncertain native write remains unreconciled and is never automatically retried. Embeddings stay local through PostgreSQL and Ollama `nomic-embed-text` (768 dimensions).

## Controlled rollout, after separate operator approval

1. **Authorize maintenance.** Approve a reviewed release SHA, change window, private data and global-role backups, isolated restore rehearsal and a fail-closed rollback. Merging this PR does not authorize activation.
2. **Seal the Bridge executable while preserving its runtime data.** The current `/home/bridge` checkout/ancestors are mutable by its agent uid and cannot authenticate root authority. Produce a separately reviewed root-controlled executable release under `/var/lib/bridge-runtime/linear-agent-bridge/agent-bridge.mjs`, with trusted ancestors and an explicit compatibility plan preserving existing `linear-jobs/`, routing and inbox paths. Review the code/data separation and systemd replacement before switching. A hash or chmod of individual files under a writable parent is insufficient. Pin the actual systemd MainPID and `/proc/PID/stat` start ticks after launch.
3. **Install a sealed memU runtime.** Provision independently reviewed, immutable Python dependencies under `/var/lib/bridge-memory-authority-runtime/bin/python`; verify their ownership/symlink chain and local-only embedding configuration. Never run agent-owned packages with root authority.
4. **Rehearse and apply M12 PostgreSQL isolation.** Quiesce connections; protect and test data plus global-role backups. Apply reviewed transactional `002_memu_scope_authority.sql` under a maintenance window; it takes ACCESS EXCLUSIVE table locks and builds unique indexes. Use `003_memu_scope_login.sql` to provision only the approved scope's NOLOGIN roles; install narrowly mapped local peer authentication from OS root, reject other hosts/databases, verify forced RLS and independent ownership, then activate the exact scoped logins. Retain the fail-closed `004_memu_scope_disable.sql` procedure.
5. **Stage the protected client and unit.** Install the reviewed standalone Node client as root:root 0644 with root-owned non-writable ancestors. Install the proposed `verified-memory-authority.service` unit without enabling it. Its root process uses primary group `bridge`, a limited writable set and no general-purpose IPC operations. The unit uses `ProtectHome=read-only` because canonical job-state and task files reside beneath `/home`; `ProtectHome=yes` would make admission verification impossible. Use the reviewed, root-owned checkout at `/var/lib/bridge-memory-authority-code`.
6. **Pin one approved task.** Fill the template at `memory/host-ipc/activation.example.json` with an authenticated admitted `jobKey`, actual completed Linear issue, exact independently approved merged PR head, real required checks and authorized reviewer, reviewed short learning Git blob, four scope fields, the canonical admitted job ledger and the root-approved repo mapping. Pin each source repository as a separate root-owned reviewed checkout and exact Git HEAD SHA. Bind the exact reviewed Git release and newly launched Bridge PID/start ticks. The checked-in example sets `activation:false`. A live private `activation.json` (root:root mode 0600) is created only after explicit operator approval; never put it in Git.
7. **Start one observed canary.** Confirm that a normal same-uid `bridge` shell/agent cannot connect, while the exact live service MainPID can. Only then separately opt into `BRIDGE_VERIFIED_MEMORY_ENABLED=true` through the approved systemd release process. Keep the prior default-off behavior outside the canary.
8. **Verify the live memory lifecycle.** Test one approved independent review/Linear completion and native commit, fresh-process signed recall into a subsequent Bridge session, local embeddings, unrelated scope/tenant/repository denials, no duplicate writes after replay, bounded redacted logs and service restarts. Confirm an error/timeout omits reference material rather than blocking job admission. Use actual trusted evidence, not synthetic fixture responses.
9. **Operator acceptance record.** After all live tests, and only then, record a root-private `m14-acceptance.json` (0600) containing `schemaVersion:1`, `accepted:true`, exact approved `releaseSha`, and seven true outcomes: `livePromotion`, `newSessionRecall`, `foreignScopeDenied`, `duplicateDenied`, `localEmbedding`, `rollbackTested` and `serviceIdentity`. The read-only readiness script validates this exact record, but never creates or guesses it. Mark ABR-59 complete only when all acceptance gates are true.

## Recovery and rollback

Disable the Bridge feature flag and stop the root authority service first. For full database shutdown, quiesce clients, revoke the exact root peer mappings and run `004_memu_scope_disable.sql` to terminate scoped login access while **preserving all native memory and journal rows**. Revoke the operator signing key for subsequent recall, not previously issued text. Reconcile ambiguous native writes manually using the exact journal/file/segment evidence; never retry an uncertain commit. Restart and reapproval require new trusted release and Bridge PID/start ticks, verified RLS, and an independently observed canary.

## Validation

`python3 -m unittest discover -s memory/host-ipc -p 'test_*.py'` verifies manifest bounds, scope and job denials, real Linux peer credentials and protocol framing. `node --test memory/host-ipc/*.test.mjs` verifies Node's independently validated job contract and standalone Unix client against an isolated local fake server. The previous M12/M13 disposable PostgreSQL canary covers native embeddings, independent approval and fresh-process signed recall. No live credential exchanges occur in these source tests.

`python3 memory/host-ipc/readiness.py` produces a **read-only** JSON gate matrix; `--strict` exits nonzero until all operator prerequisites and a recorded live acceptance pass. No command in this source change automatically provisions keys, migrates a database, installs a privileged unit or enables a feature flag.


## Review hardening (PR #278)

- **Root code integrity:** The authority scans the full root-controlled checkout before local imports, rejects symlinks, mutable descendants, dirty tracked files, ignored and untracked files, and requires the exact approved Git SHA. The Node worker dynamically imports its local modules only after the same checks. Source repositories have independent root-owned checkouts and SHA pins, never an implicit fallback to the authority's source code.
- **Admission and manifest integrity:** Each operator-selected job must also match the canonical hashed Bridge ledger and original task file in every admitted dimension. The server passes the SHA-256 of the exact approved manifest to the worker; any intervening rebinding refuses the operation.
- **Durable completion:** A completion hint is persisted and fsynced in the private root intent journal before acknowledgment. Duplicate or partially executed work does not repeat automatically; after restart, queued/running intents become explicit reconciliation tasks. Recall while a promotion is unconfirmed is denied.
- **Resource bounds:** The protected listener limits outstanding handlers to eight, with a four-worker pool. Same-uid agent flooding cannot create an unbounded privileged queue.
- **Database readiness:** Read-only PostgreSQL inspection explicitly targets the production Unix socket `/var/run/postgresql`, port `5433`, database `agent_memory`. It verifies all five reviewed M12 RLS policy definitions by PostgreSQL 18 expression fingerprints, correct group/individual role attributes and grants, exact operator-pinned scope login mappings, and revocation of the legacy Bridge owner's privileges. The disposable M12 canary verifies both accepted roles and denied unauthorized privilege/map mutations.
- **Live readiness:** Requires root authority mode 0700, clean sealed code checkouts, executable Python, a client readable by `bridge`, active exact reviewed systemd unit and effective sandbox, responsive root-controlled Unix socket, current Bridge MainPID/start ticks and separately reviewed Bridge release SHA. An old acceptance record alone cannot pass after a restart.
- **Operation deadlines:** Lookup/notification are bounded to 1.5 seconds; approved read-only recall has an 11-second client limit and 12.5-second Bridge cap, allowing the eight-second native worker plus launch and verification overhead. Failed reads omit optional context, never trigger a retry of a write.

These are tested source properties, not production activation or a live canary.

## Production code/data separation and schema audit correction

The immutable Bridge source must not write mutable `linear-jobs` and agent
workspace files into the root-controlled Git checkout. The reviewed launch
uses `BRIDGE_RUNTIME_PROJECT_DIR` to retain the existing writable
`/home/bridge/agent-bridge/linear-agent-bridge` runtime, while importing
only from the clean Git release at `/var/lib/bridge-runtime`. Its root-owned
`/etc/agent-bridge/bridge.env` must have mode 0640, be group-readable but
non-writable by the bridge Unix account, and be copied from the currently
running service environment under operator supervision. The launcher sources
only that path, clears `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `BASH_ENV`, `ENV` and `PYTHONPATH`, then executes the
trusted `/usr/bin/node` binary against the reviewed entrypoint. Existing
writable source and job-state remain available for service rollback.

The root authority needs CAP_DAC_READ_SEARCH to inspect the mode-0600
canonical job ledger under `ProtectHome=read-only`. Without it, the old
empty capability bounding set refused job state, and `ProtectHome=yes` would
hide the directory. The authority still cannot alter agent-owned files.

PostgreSQL policy expression fingerprints depend on `search_path` rendering.
The reviewed M12 policy expressions were recorded under `memu,public`. The
read-only M14 SQL gate pins this schema explicitly before comparing the five
fingerprints. This does **not** change policies, schemas or grants; it aligns
the production audit with the disposable cluster's canonical namespace.

Managed-submission release integrity is checked against the immutable
SOURCE_PROJECT_DIR even when writable runtime paths are redirected; the host
binding never accepts the rollback workspace's potentially different Git HEAD
as the trusted executable release.
