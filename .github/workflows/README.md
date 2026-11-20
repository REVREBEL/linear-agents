# GitHub Actions workflow ownership

The files in this directory are reviewed CI workflows. Workflow changes are source-controlled and must not deploy to production without a separate approved action.

**ABR-94 — `mcp-foundation.yml`:** Runs pinned local, read-only MCP provenance/tool-parity tests and an isolated localhost HTTP+paired WebSocket smoke fixture. It also runs `npm run bridge:test` to preserve the existing bridge contract. Workflow credentials are read-only (`contents: read`), and no live service, edge hostname, external plugin, device agent, or production database is installed.

The MCP security/tool source audit and full deferred-gate list are at [ABR-94](../../docs/audits/mcp/README.md). Existing `worker-reliability.yml`, `agent-context-blueprint.yml`, `owning-readme-discipline.yml` and other workflow checks remain independent and authoritative.

**ABR-95 — `mcp-oauth.yml`:** Runs offline signed-token, PKCE fixture and 2026/2025 MCP transport tests followed by existing ABR-94 foundation and Bridge regression checks. It has read-only checkout permissions and no token issuance, Cloudflare API, route, tunnel or production service action.

**ABR-96 — `mcp-executor.yml`:** Installs test-only `bubblewrap` on an ephemeral Ubuntu runner, checks the nonprivileged OS namespace probe, runs sandbox/admission/journal tests with isolated fixtures, and re-runs existing Bridge/MCP regressions. The fallback root test is **explicitly test-only** and never enables a production service or satisfies the real Ubuntu `bridge` AppArmor release gate; skipped runtime cases must be reported honestly.
