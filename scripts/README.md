# Repository scripts

This directory contains **versioned project commands and their tests**. It is not a deployment destination for machine-global CLI installation, private agent profiles, host credentials, or `/opt/agents` runtime state.

## Runtime and CI

- `workspace-command.mjs`, `agent-worker-registry.mjs`, `registry-worker-info.mjs`, `render-wrangler.mjs`, `workspace-typecheck.mjs` and `with-env.sh` support registered Worker commands and CI.
- `bridge.sh`, `platform-setup.sh`, `linux/` and `macos/` provide versioned, platform-aware bridge entrypoints and installation helpers. Installation is opt-in; CI never executes setup actions.
- `*.test.mjs` are the regression suites invoked by `package.json`.
- Remaining command helpers are retained where `package.json`, the bridge or integration tests reference them.

## Host-only infrastructure

One-time Ubuntu `/opt` bootstrap, global permission changes, shared shell configuration, Volta rebuilds, and central CLI/profile installation scripts are **not** part of this recovery PR. Those belong to the separate host infrastructure ownership path. Never automatically copy or run those scripts on a live server as part of npm installation or CI.

`npm run types`, `npm run typecheck`, `npm run test:reliability`, `npm run bridge:test`, and `npm run registry:validate` are the primary verification commands.
