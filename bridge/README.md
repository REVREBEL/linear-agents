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
