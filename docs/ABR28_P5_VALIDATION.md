# ABR-28 P5: Integration and Production Validation

## Milestone P5.1: isolated smoke and recovery baseline

This first milestone is deliberately **non-destructive**. It adds a local-only smoke check and CI regression tests. It does not deploy or restart the running Ubuntu bridge, install packages on the server, connect to the Mac, publish Linear messages, or make test bookings or GitHub changes. Do not treat the passing CI harness as an end-to-end production verification.

### Prerequisites

- Confirm ABR-28 P4 PRs #151, #152, #153, and #154 are merged before considering full P5 cutover testing. This P5 harness is independent of the pending #154 HTTP composition changes.
- Run commands on the Ubuntu bridge host, from the checked-out `REVREBEL/linear-agents` repository, with the correct service environment made available to the shell.
- `BRIDGE_SHARED_SECRET` must be present **in the process environment**, never embedded as a CLI argument or echoed to a terminal. Use your existing authorized secret loader rather than copying secrets into documentation or chat.
- `BRIDGE_PORT` defaults to `8788`. The check always targets `http://127.0.0.1:<port>`, irrespective of `BRIDGE_HOST`, public domains or reverse proxies.

### Operator procedure

1. Verify the working tree and active deployment version using your normal repository and systemd inspection tools. Do not upgrade or restart the service for this read-only validation.
2. With the bridge already running and authorized environment loaded, run `npm run bridge:smoke` on the **same host** as the bridge.
3. Verify the single `PASS` message. A nonzero exit means some expected contract failed, not that a restart is required.
4. Check the existing service logs independently for unexpected failures. The smoke script does not print credentials, payloads, or send a job.
5. Record the commit hash, service version, observed result, and tester in the rollout record. Keep credentials and callback capabilities out of that record.

The smoke script verifies `GET /health` (HTTP 200), an unauthenticated `POST /diagnostics/probe` rejection (401), and an authenticated `POST /diagnostics/probe` (HTTP 200 with matching random probe ID). All three requests are side-effect-free and bound to loopback. It never sends `POST /jobs`.

### Automated, isolated regression coverage

`npm run test:reliability` includes `scripts/p5-bridge-smoke.test.mjs`, covering real ephemeral loopback HTTP requests, unauthorized and malformed results, rejected bad inputs, filesystem-backed job ledger restart reconciliation, per-agent delivery deduplication, and received-only unrouted retry eligibility.

Temporary test servers bind to `127.0.0.1` on an OS-assigned port; temporary ledgers are created with `mkdtemp` and removed after each test. CI does not contact Ubuntu production, Cloudflare, Linear, Mac SSH, or external providers.

### Remaining P5 gates, intentionally not claimed by this milestone

- **P5.2**: controlled test deployment or staging execution of Linux local agents, with verified process lifecycle and Linear messages. Explicitly identify a safe test issue and test app; never reuse a production customer issue.
- **P5.3**: macOS SSH Trae runner acknowledgment, callback token validation, activity and completion handoff, and timeout/failure recovery.
- **P5.4**: supervised Ubuntu restart/reconciliation: no duplicate launches from `received`, `queued`, `launching`, or `running` ledgers; explicit manual disposition of ambiguous interrupted jobs.
- **P5.5**: verify Cloudflare webhook and Linear response acknowledgment for valid, rejected, duplicate, delayed, and resumed deliveries. Include operational rollback conditions and evidence log.

Passing P5.1 is **not** permission to restart the live bridge, move persisted job roots, or mark the end-to-end agent loop production-verified.

## Repository folder consolidation (P5 structural checkpoint)

The canonical bridge implementations are now physically located in these folders:

| Canonical file | Previous import path (compatible re-export) |
| --- | --- |
| `bridge/server/http-route-composition.mjs` | `bridge/http-route-composition.mjs` |
| `bridge/handlers/diagnostic-routes.mjs` | `bridge/diagnostic-routes.mjs` |
| `bridge/config/agent-host-resolver.mjs` | `bridge/agent-host-resolver.mjs` |
| `bridge/orchestration/job-admission-coordinator.mjs` | `jobs/job-admission-coordinator.mjs` |

The service entrypoint imports the canonical paths, while old imports preserve exact module function identity. Individual folders include README guidance, and CI checks both source ownership and shim interoperability.

**Important scope boundary:** This checkpoint establishes the physical folder topology and relocates four ownership modules. It does **not** claim all handlers, adapters, configuration, and runtime files are already under their final subdirectories. Follow-up migrations should move those components incrementally, each with contract tests and old-path shims until their consumers are updated.

The Ubuntu systemd entrypoint remains `linear-agent-bridge/agent-bridge.mjs`; `PROJECT_DIR`, `JOBS_DIR`, `linear-jobs/`, local state, token stores and Mac SSH runner paths are unchanged. A runtime-state move to `/var/lib/agent-bridge/` still requires a separate supervised migration, rollback procedure, and restart window.
