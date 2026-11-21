# Device-side MCP foundations

`mcp-host-agent/` contains the independently written **read-only, test-only** outbound local WebSocket host fixture for ABR-94. It does not change the existing Bridge admission/execution architecture, replace `jobs/persistence/job-store.mjs`, mint an agent identity, or install a service.

See [MCP host fixture](mcp-host-agent/README.md) and [upstream/parity audit](../../docs/audits/mcp/README.md). The privileged Ubuntu/macOS executor, authorized process operations, pairing rotation and sandboxing belong to ABR-96/97.

## ABR-96 — Sandboxed Ubuntu host executor

`mcp-host-agent/` additionally contains the standalone authenticated execution service with Bubblewrap/prlimit namespace constraints, per-device/user/client/session/project authorization, SQLite outcome idempotency and interactive-process streaming. It is a source-only adapter, **not** an automatic extension to the paired read-only MCP agent or to the production Linear dispatcher. The service-user AppArmor policy gate remains blocked. See [executor safety and restart contract](../../docs/audits/mcp/EXECUTOR.md).

## ABR-97 — Approved device choice and macOS discovery

The separate `mcp-host-agent/device-enrollment.mjs`, `device-routing.mjs`, and `macos-host-probe.mjs` establish signed, expiring host pairing and a trusted route decision for actual SSH or paired WS targets. The real Mac's launchd Node and project root were read over strict SSH, without altering it; the existing read-only agent and Linux executor remain independent. [ABR-97 Mac/Ubuntu runbook](../../docs/audits/mcp/MACOS_HOST.md).

## ABR-98 — New guarded source adapters

`mcp-host-agent/process-state.mjs` classifies Python, Pdb, MySQL and shell prompts independently of timing; `git-readonly.mjs` uses ABR-96's Bubblewrap sandbox; `ast-structured.mjs` safely reads JavaScript/TypeScript AST and defaults edits to diff-only; `pdf-offline.mjs` renders Markdown subset and edits PDF pages without Chrome download, requiring an independent document-write scope and approved output writer. These remain source-only and cannot bypass live Mac/Ubuntu host policy. See [tool profiles and parity obligations](../../docs/audits/mcp/PROFILES.md).
