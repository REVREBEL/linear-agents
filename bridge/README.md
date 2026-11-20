---
context:
  id: repo.bridge
  version: 1
  title: Agent Bridge runtime
  topics: [bridge, dispatch, deployment, profiles]
  requires: [repo.agents, host.agent-runtimes, host.agent-tools, host.global-tools]
  applies_to: ["bridge/**", "jobs/dispatch/**", "jobs/admission/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Canonical bridge architecture

- `server/`: production runtime, HTTP helper primitives, route composition
- `handlers/`: diagnostic, review, GitHub, Trae and issue-completion routes
- `config/`: host-to-agent resolution
- `orchestration/`: admission, local/remote execution, prompt parsing, review state/handoff

`linear-agent-bridge/agent-bridge.mjs` is the stable **thin runtime loader** for systemd, LaunchAgent and CLI. The real implementation is `server/agent-bridge-runtime.mjs`, which pins `PROJECT_DIR` to the loader's original location. Flat legacy `bridge/*.mjs` files are import-only compatibility shims; new code should use the canonical modules. See `docs/ABR28_P5_VALIDATION.md`.

## Isolated MCP source audit and local-only test foundation (ABR-94)

`server/mcp-relay/` and `agent/mcp-host-agent/` contain a separately instantiated **read-only local fixture** that is **not imported or enabled** by the running Bridge server. Its source provenance, exact 30/42/3 tool dispositions and security gates are documented at [ABR-94 source audit](../docs/audits/mcp/README.md). Future ABR-95–99 tasks must add authorization, the real privileged executor, multi-host routing and trusted submission as adapters, not a parallel job ledger.

## Authorization boundary for the local MCP proof (ABR-95)

The local `server/mcp-relay/` fixture optionally requires cryptographically validated access tokens from a reviewed external issuer. This remains separate from the canonical Linear `/jobs` admission and does not grant authority to write tasks, access memory or promote work. Source contracts and deployment gates are documented in [ABR-95 OAuth and edge plan](../docs/audits/mcp/OAUTH_EDGE.md); production ingress and OAuth client configuration are not activated by source merge.

## ABR-96 — Separate OS-sandbox execution adapter

`agent/mcp-host-agent/execution-service.mjs` composes a **nonproduction** Ubuntu Bubblewrap executor with private scoped authority, interactive terminal handles and a distinct SQLite execution-outcome journal. It is not imported into the authoritative Bridge server or job ledger. The actual `bridge` OS user currently fails the rootless namespace preflight, so this code is not deployable until an approved narrow AppArmor policy succeeds. Details and rollback: [ABR-96 executor audit](../docs/audits/mcp/EXECUTOR.md).
