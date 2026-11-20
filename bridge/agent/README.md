# Device-side MCP foundations

`mcp-host-agent/` contains the independently written **read-only, test-only** outbound local WebSocket host fixture for ABR-94. It does not change the existing Bridge admission/execution architecture, replace `jobs/persistence/job-store.mjs`, mint an agent identity, or install a service.

See [MCP host fixture](mcp-host-agent/README.md) and [upstream/parity audit](../../docs/audits/mcp/README.md). The privileged Ubuntu/macOS executor, authorized process operations, pairing rotation and sandboxing belong to ABR-96/97.

## ABR-96 — Sandboxed Ubuntu host executor

`mcp-host-agent/` additionally contains the standalone authenticated execution service with Bubblewrap/prlimit namespace constraints, per-device/user/client/session/project authorization, SQLite outcome idempotency and interactive-process streaming. It is a source-only adapter, **not** an automatic extension to the paired read-only MCP agent or to the production Linear dispatcher. The service-user AppArmor policy gate remains blocked. See [executor safety and restart contract](../../docs/audits/mcp/EXECUTOR.md).
