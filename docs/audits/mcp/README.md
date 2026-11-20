# ABR-94 — Desktop Commander MCP foundation: source audit and local proof

**Status: local, read-only, test-only foundation.** This PR does **not** install, start or change a running systemd/launchd service, Cloudflare Tunnel, OAuth issuer, PostgreSQL schema, GitHub/Linear submission path, or remote workstation agent. No public endpoint or production credentials are created.

## Pinned source review

[upstream-lock.json](upstream-lock.json) records full source HEAD SHA, Git blob IDs, SHA-256 and byte counts of independently inspected upstream files and MIT license texts.

| Repository | Verified commit | Version | Use |
| --- | --- | --- | --- |
| [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander) | `aee7115cb01bc0de21f1405b5f8e81ab56234733` | v2.0.17 | Relay/agent topology, tool inventory, attack-surface reference |
| [wonderwhy-er/DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) | `9a101b17e44577f0baefa4c7120f087881c5cc56` | v0.3.4 | Exact existing process/read-file behavior and prompt heuristic reference |

Both source repositories carry an MIT license. **No upstream source code or third-party runtime files have been copied into the bridge.** The small relay and agent below are independently authored, limited implementations informed by the reviewed architecture. Their sole added dependency is `ws@8.21.0` locked by the root `package-lock.json`. Upstream BRC requires Node >=22.13 for its own runtime, uses pnpm 11.24.0, an `@modelcontextprotocol/sdk` 1.x range, Express 5, and a far broader dependency graph; none of those dependencies are imported by this proof.

### Source-by-source disposition

| Upstream path at pinned commit | Disposition | Reason |
| --- | --- | --- |
| BRC `packages/relay/src/mcp/server.ts`, `invoke.ts` | **Adapt architecture** | Independent localhost JSON-RPC test relay with authenticated tool calls and explicit device selection; full production MCP transport deferred to ABR-95 |
| BRC `packages/relay/src/auth/provider.ts` | **Defer ABR-95** | PKCE, OAuth client registration, resource/audience and proxy validation require their own protocol review |
| BRC `packages/relay/src/mcp/tool-profiles.ts` | **Design reference** | Authorizations are checked at invocation. Foundation lists only two safe tools regardless of named profile; full profile behavior belongs to ABR-98 |
| BRC `packages/relay/src/app.ts` | **Reject capability links** | Do not port URL-only `/c/:key/mcp` bearer access or public admin routes |
| BRC `packages/relay/src/mcp/plugin-tools.ts` | **Reject default plugin marketplace** | No remote registry search, install flow or arbitrary plugin-tool invocation |
| BRC `packages/agent/src/dispatcher.ts`, `tools/brc-tools.ts` | **Defer ABR-96/98** | One-shot shell commands, write operations and structured Git helpers require OS-sandbox and tool-specific authorization |
| BRC `packages/agent/src/tools/jobs.ts` | **Defer ABR-96** | Detached/parallel jobs are process execution only and must not become the Linear ledger |
| BRC `packages/agent/src/tools/ast-grep.ts` | **Defer ABR-98** | AST read/write operations need reviewed binary and dry-run/authorization tests |
| BRC `packages/agent/src/core/file-transfer.ts` | **Reject** | Calls `https://tmpfiles.org/api/v1/upload`; no external code-transfer route is allowed in this foundation |
| BRC `packages/agent/src/core/terminal-manager.ts` and Desktop Commander `src/terminal-manager.ts` | **Defer ABR-96/98** | Preserve interactive prompt detection, process IDs and cancellation only with sandbox and golden-output tests |
| Desktop Commander `src/remote-device/remote-channel.ts` | **Reject** | Third-party proprietary remote device relay is not used |
| BRC/ upstream PDF/document modules | **Defer ABR-98** | Current 30-tool client already has `write_pdf`; preserve it in the full port with approved offline rendering rather than silently removing it |

BRC's pinned source also contains other dev-extras, source/plugin wrappers and outgoing fetch paths. The tool count in the README alone is not an execution allowlist. Reusing the full upstream package as-is would import authority, egress and dependencies not approved for this Bridge.

## Machine-readable baseline

[tool-parity.json](tool-parity.json) records all **30 callable connected** Remote Desktop Commander names, all **42 BRC agent** tools, all **3 BRC relay** tools, and 50 distinct names. Exactly 24 connected tool names match BRC agent names, one connected tool (`list_devices`) matches a BRC relay tool, five connected names need adapter/review decisions, and 18 BRC agent names are not present in the connected baseline. Each entry has ownership, intended disposition, connected input signature, test ID and explicit status.

The existing plugin's declared TypeScript argument types are recorded as a connected-client input signature. This is **not** represented as a verified full BRC `tools/list` JSON Schema. ABR-98/100 must capture and compare actual JSON schemas, output bodies and errors from real clients on both hosts. No unimplemented name is counted as proven parity.

Selected decisions: preserve current `write_pdf`; require an authorized capability for destructive file/config changes; adopt useful `git_*`, `run_command`, `run_parallel`, `spawn_job` and `ast_*` tools after sandbox tests; reject file transfers through third-party storage; deny plugin marketplace or arbitrary sub-MCP execution until separately reviewed.

## Working local proof

- `bridge/server/mcp-relay/index.mjs` has a test-created HTTP listener bound **only** to `127.0.0.1` on an OS-selected ephemeral port. There is no startup binary, long-running unit or public routing.
- The MCP test endpoint `POST /mcp` requires a separate >=32-character operator-supplied local-client bearer secret (deterministic values are used only in tests), validates request size, HTTP host/origin and a small JSON-RPC subset: `initialize` (pinned to `2025-06-18` as an **ABR-94-only fixture**), `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- The paired host agent uses outbound WebSocket `/agent`, a **separate** operator-supplied agent secret, fixed device identity, no public DNS/Cloudflare ingress and no app auto-registration. Bad pairing, unknown device, duplicate connection and offline device fail closed.
- **Only `read_file` and `list_devices` exist as invocable tools**. The host agent enforces an absolute non-root workspace, real-path containment including symlink escape, UTF-8-only reads, ordinary-file/256-KiB input bounds, nonblocking FIFO checks, complete-response 512-KiB wire bounds and line pagination. It never launches a process, writes, uploads, installs plugins or calls Linear. Tool errors are bounded, and transport disconnect clears pending requests.
- `core`, `focused`, and `full` labels are accepted as test parameters, but the proof **does not advertise additional tools**. Security is enforced on every `tools/call`, even by unlisted tool names. The authenticated local bearer fixture is **not a production OAuth implementation**, and this local server is not a general-purpose MCP server.
- **Security boundary:** Realpath checks are a first gate, not an OS filesystem sandbox; ABR-96 must add process-user and syscall/volume containment, race-resistant path operations, independent per-user/device scopes and durable process management. ABR-95 must replace the prototype token/transport handshake with the reviewed MCP and OAuth specification, origin/proxy validation and production-grade enrollment.

## Verify

With Node 26 and dependencies from the repository lockfile:

```sh
node --test scripts/test-mcp-source-audit.mjs scripts/test-mcp-foundation.mjs
```

The suite verifies immutable upstream provenance, the exact 30/42/3 tool matrix, authenticated and denied HTTP/WS behavior, device pairing, path traversal, escape by symlink, exact Markdown reads/SHA-256, unknown privileged tool denial, no callable exfiltration or plugin tools, local-only ingress and disconnect behavior. No external network, cloud account, live bridge, private credential or production port is involved.

## Next issue gates

- **ABR-95:** full current MCP/OAuth transport, resource audience/issuer scope, approved Cloudflare/access, client DCR tests.
- **ABR-96:** OS sandbox, persistent process and background job compatibility with no duplicate side effects.
- **ABR-97:** macOS paired agent, two-host authorization, revocation and offline handling.
- **ABR-98:** full 30-tool parity and approved BRC extensions, REPL/document handling and profile gating.
- **ABR-99:** trusted Bridge checkpoint/submission/reviewer adapter (ABR-90 and ABR-17 contracts).
- **ABR-100:** full two-host external-client/Agent Context C–E regression gate before any production activation.

Neither initial paired-read success nor static egress checks imply safe deployment. The rollout gate remains a separately approved future action.
