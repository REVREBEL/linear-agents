# GitHub Actions workflow ownership

The files in this directory are reviewed CI workflows. Workflow changes are source-controlled and must not deploy to production without a separate approved action.

**ABR-94 — `mcp-foundation.yml`:** Runs pinned local, read-only MCP provenance/tool-parity tests and an isolated localhost HTTP+paired WebSocket smoke fixture. It also runs `npm run bridge:test` to preserve the existing bridge contract. Workflow credentials are read-only (`contents: read`), and no live service, edge hostname, external plugin, device agent, or production database is installed.

The MCP security/tool source audit and full deferred-gate list are at [ABR-94](../../docs/audits/mcp/README.md). Existing `worker-reliability.yml`, `agent-context-blueprint.yml`, `owning-readme-discipline.yml` and other workflow checks remain independent and authoritative.

**ABR-95 — `mcp-oauth.yml`:** Runs offline signed-token, PKCE fixture and 2026/2025 MCP transport tests followed by existing ABR-94 foundation and Bridge regression checks. It has read-only checkout permissions and no token issuance, Cloudflare API, route, tunnel or production service action.

**ABR-96 — `mcp-executor.yml`:** Installs test-only `bubblewrap` on an ephemeral Ubuntu runner, checks the nonprivileged OS namespace probe, runs sandbox/admission/journal tests with isolated fixtures, and re-runs existing Bridge/MCP regressions. The fallback root test is **explicitly test-only** and never enables a production service or satisfies the real Ubuntu `bridge` AppArmor release gate; skipped runtime cases must be reported honestly.

**ABR-97 — `mcp-devices.yml`:** Runs offline two-host, signed device approval, session/Linear routing and macOS SSH-probe source tests with read-only repository access. It does not reach the real Mac, authorize host keys, issue production tokens, install launchd or modify Ubuntu services. Real SSH evidence and the outstanding process sandbox gates are documented in `docs/audits/mcp/MACOS_HOST.md`.

**ABR-98 — `mcp-profiles.yml`:** Tests verified core/focused/full MCP discovery and hidden-call authorization, offline OAuth integration, bounded structural source/Git handlers, Chrome-free PDF integrity, and deterministic terminal status fixtures, then runs strict ABR-96 sandboxed REPL/cancellation acceptance plus existing ABR-94–97 and Bridge regressions. Uses read-only repository permissions, locked MIT npm parser/PDF dependencies, and an ephemeral Linux sandbox for Git fixture checks. No live service, device enrollment or Cloudflare change occurs.

**ABR-99 — `mcp-bridge-integration.yml`:** Validates source-only authenticated Linear job scope, actual canonical checkpoint CAS, replay-safe tool milestones, review inbox PR/head dedupe, separate reviewer acknowledgment, disabled-until-ABR-17 `submitWork`, and D5 portable handoff fixtures; preserves existing MCP, Bridge and reliability suites with read-only checkout. No live Linear/GitHub/Worker/Mac/Cloudflare/PostgreSQL write or production deployment.

**ABR-17 — `submission-coordinator.yml`:** Isolated opt-in coordinator, transactional outbox, per-stage failure/recovery and secret-redaction fixtures, plus Bridge and reliability tests and typechecking. No live publication or service changes.

**ABR-17 M2 — `submission-coordinator.yml`** also executes the private-ingress, actual child IPC, signed fixture broker, and strict Linux sandbox Git preflight tests using the existing isolated test-only root override. Never deploys, loads production credentials or changes service policy.

**ABR-17 M3:** Submission coordinator CI now runs `submission:m3:test` covering fixed provider contracts, publication boundaries and read-only reconciliation using signed test fixtures. The inherited M1/M2, Bridge, reliability and generated Worker type checks remain required.

**ABR-17 M4:** Submission coordinator CI adds managed native launch/IPC and shared MCP finish regression tests using the previous provider-shaped HTTP fixtures. No real agent launch, private deployment binding or production activation.

The M4 workflow runs the AGY Python unit suite in a disposable venv as well as Node managed-dispatch fixtures.

**ABR-17 M5:** strict isolated Linux fixture CI includes the real FD/sandbox canary, exclusive lock/crash test, offline receipt recovery and root activation refusal. The host readiness report must separately verify actual service UID conditions at rollout.

**ABR-59 M14 — memory-authority-m14.yml:** Read-only isolated Ubuntu tests for a root-protected AF_UNIX memory authority, pinned per-job manifest and client protocol. Exercises actual kernel `SO_PEERCRED` negatives, bounded requests and standalone Node client without touching real credentials, production databases or services. The readiness output deliberately reports pending deployment/acceptance gates.

M14 production hardening extends isolated CI to verify the reviewed
immutable-code/runtime-data split, shell launcher and both systemd units,
in addition to native Python and Node IPC controls.

The M14 isolation workflow listens to changes in the canonical
`bridge/server/agent-bridge-runtime.mjs` for both pull requests and main
pushes, and validates the reviewed canonical `agent-bridge.service`
deployment template (rather than a separately named sealed service).

## ABR-17 M5 sealed-release readiness verification

The Submission Coordinator CI runs `scripts/test-submission-host-readiness.py`
before the isolated M2/M5 tests. This regression checks that the read-only
host report resolves the active systemd service's exact sealed Node release
rather than a writable development checkout and rejects malformed PATH/IDs.
The tracked workflow also includes the narrowly scoped sealed Git ACL
operator script in its change filters.
