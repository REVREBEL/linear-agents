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
