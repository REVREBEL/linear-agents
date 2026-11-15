# Bridge source architecture

- `server/`: HTTP protocol helpers and route composition
- `handlers/`: authenticated and public ingress handlers
- `config/`: host-to-agent resolution
- `orchestration/`: job admission, agent execution, prompt parsing, review lifecycle

`linear-agent-bridge/agent-bridge.mjs` remains the compatible operational entrypoint and owns live runtime root `linear-jobs/`. Never move it or `linear-jobs/` as part of source-only refactors. Flat `bridge/*.mjs` paths are backward-compatibility re-exports; import canonical modules in new code. See `docs/ABR28_P5_VALIDATION.md`.
