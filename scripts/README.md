# Repository scripts

This directory contains **versioned project commands and their tests**. It is not a deployment destination for machine-global CLI installation, private agent profiles, host credentials, or `/opt/agents` runtime state.

## Runtime and CI

- `workspace-command.mjs`, `agent-worker-registry.mjs`, `registry-worker-info.mjs`, `render-wrangler.mjs`, `workspace-typecheck.mjs` and `with-env.sh` support registered Worker commands and CI.
- `bridge.sh`, `platform-setup.sh`, `linux/` and `macos/` provide versioned, platform-aware bridge entrypoints and installation helpers. Installation is opt-in; CI never executes setup actions.
- `*.test.mjs` are the regression suites invoked by `package.json`.
- Remaining command helpers are retained where `package.json`, the bridge or integration tests reference them.

## Staged CLI inventory reconciliation (ABR-63)

`reconcile-agent-runtimes.py` reads the reviewed **Git** source at `templates/context/agent-runtimes.staged.json` and checks the independent, non-dispatching **host** snapshot at `/opt/agents/registry/agent-runtimes.json`. The default and `--check` modes are read-only; `--validate` checks the reviewed source, `--probe` inspects path presence only, and `--render` prints the desired JSON. `--apply` explicitly backs up and atomically replaces only an existing, disabled, schema-v1 staged file after review/merge. Run `python3 scripts/test_reconcile_agent_runtimes.py` for the isolated backup/drift/safety regression tests. See [the host inventory guide](../docs/blueprints/agent-context/RUNTIME_INVENTORY.md).

This script does **not** deploy a Worker, enable an agent, modify a CLI profile, or repair the separate `agent-exec` wrapper managed under ABR-54.

## Research-profile promotion (ABR-64)

`review-research-promotion.py` takes a canonical research candidate ID and an independently reviewed JSON mapping record. It compiles and prints a **non-executable Registry v2 proposal with provenance**; it never changes `agents/registry.json`, provider runtime state, authorization, or a Worker. The deliberately incomplete template is `templates/context/research-promotion.review.template.json`; the contract and approval limitations are documented in [PROMOTION.md](../docs/blueprints/agent-context/PROMOTION.md). Run `python3 scripts/test_review_research_promotion.py` for offline regressions.

## Host-only infrastructure

One-time Ubuntu `/opt` bootstrap, global permission changes, shared shell configuration, Volta rebuilds, and central CLI/profile installation scripts are **not** part of this recovery PR. Those belong to the separate host infrastructure ownership path. Never automatically copy or run those scripts on a live server as part of npm installation or CI.

`npm run types`, `npm run typecheck`, `npm run test:reliability`, `npm run bridge:test`, and `npm run registry:validate` are the primary verification commands.
