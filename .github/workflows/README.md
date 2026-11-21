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
