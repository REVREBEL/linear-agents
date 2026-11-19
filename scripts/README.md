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

## Versioned context-template publishing (ABR-71)

`publish-context-templates.py` publishes **Git-reviewed, inert context templates** from `templates/context/` into `/opt/agent-tools/templates/context/`. This script owns the installation boundary; it is **not** an agent runner, a context resolver, or a profile deployment mechanism.

- `python3 scripts/publish-context-templates.py --validate` — read-only validation of required tracked files, Git-committed blob integrity, and source revision.
- `python3 scripts/publish-context-templates.py --check` — read-only comparison of the installed managed snapshot against Git, including per-file SHA-256 hashes and `.managed-context.json`.
- `python3 scripts/publish-context-templates.py --apply` — explicitly install the approved snapshot **from a merged, reviewed checkout on Ubuntu**. Initial installation creates the missing context directory; updates atomically exchange complete Linux directories and retain the prior version as `context.backup-*`. Unmanaged/modified content and unsafe symlinks cause an error rather than an overwrite.

The publisher copies only the 15 required tracked Markdown, YAML and JSON template sources (and any additionally reviewed tracked template file). It does not copy `/opt/agents` runtime state, authenticate a provider, authorize Linear dispatch, or restart any service. Run `python3 scripts/test_publish_context_templates.py` for isolated tests and verify a post-merge installation with `--check`.

If `templates/context/host-roots/agent-tools/README.md` changes, reconcile its **separately managed** host README via `python3 scripts/reconcile-host-root-readmes.py --apply`, then `--check`. See the [template ownership and publishing guide](../templates/context/README.md).

## Host-only infrastructure

One-time Ubuntu `/opt` bootstrap, global permission changes, shared shell configuration, Volta rebuilds, and central CLI/profile installation scripts are **not** part of this recovery PR. Those belong to the separate host infrastructure ownership path. Never automatically copy or run those scripts on a live server as part of npm installation or CI.

`npm run types`, `npm run typecheck`, `npm run test:reliability`, `npm run bridge:test`, and `npm run registry:validate` are the primary verification commands.
