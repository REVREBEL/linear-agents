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

## Research execution-authority boundary (ABR-78 / D2)

`check-research-authority.mjs` audits tracked Bridge/Worker/routing/provider executable sources and the two Registry v2 reader scripts. It normalizes literal relative file references against each audited source path and refuses direct imports/references to research YAML, candidate files, staged host manifests, proposal payloads or context templates. `test_research_execution_boundary.py` uses fake high-privilege research candidates to prove Worker discovery remains confined to `agents/registry.json`, and checks the admission/source separation. Existing `test_review_research_promotion.py` tests show signing, model-allowlist and host-isolation claims stay descriptive while privileged mappings are rejected. All run in the dedicated [research boundary workflow](../.github/workflows/research-authority-boundary.yml) when relevant source changes. See [authority contract](../docs/blueprints/agent-context/RESEARCH_AUTHORITY.md); this is a source regression gate, not a runtime code-signature service.

## Versioned context-template publishing (ABR-71)

`publish-context-templates.py` publishes **Git-reviewed, inert context templates** from `templates/context/` into `/opt/agent-tools/templates/context/`. This script owns the installation boundary; it is **not** an agent runner, a context resolver, or a profile deployment mechanism.

- `python3 scripts/publish-context-templates.py --validate` — read-only validation of required tracked files, Git-committed blob integrity, and source revision.
- `python3 scripts/publish-context-templates.py --check` — read-only comparison of the installed managed snapshot against Git, including per-file SHA-256 hashes and `.managed-context.json`.
- `python3 scripts/publish-context-templates.py --apply` — explicitly install the approved snapshot **from a merged, reviewed checkout on Ubuntu**. Initial installation creates the missing context directory; updates atomically exchange complete Linux directories and retain the prior version as `context.backup-*`. Unmanaged/modified content and unsafe symlinks cause an error rather than an overwrite.

The publisher copies only the 16 required tracked Markdown, YAML and JSON template sources (and any additionally reviewed tracked template file). It does not copy `/opt/agents` runtime state, authenticate a provider, authorize Linear dispatch, or restart any service. Run `python3 scripts/test_publish_context_templates.py` for isolated tests and verify a post-merge installation with `--check`.

If `templates/context/host-roots/agent-tools/README.md` changes, reconcile its **separately managed** host README via `python3 scripts/reconcile-host-root-readmes.py --apply`, then `--check`. See the [template ownership and publishing guide](../templates/context/README.md).

## Agent Context metadata validation (ABR-72)

`context_contract.py` implements reviewed **v1 metadata-only** validation of `.agents/context.yaml` and source-owned README YAML headers using `templates/context/context-manifest.schema.json` and `context-frontmatter.schema.json`. It validates unique document IDs and YAML keys, safe root-relative paths, documented dependencies and cycles; the pure `select_host_root` helper supports `linux`, `darwin` and `win32` environment/platform-default precedence without accessing the target filesystem.

Run `python3 scripts/validate-context-contract.py` to validate the current Git checkout and `python3 scripts/test_context_contract.py` to run the negative/portability cases. The blueprint validator and GitHub Actions run the same contract. C1 validates declarations only: C2–C5 separately own path resolution, CLI commands, actual host-root availability and retrieval. See [the versioned contract](../docs/blueprints/agent-context/CONTEXT_SCHEMA.md).

## Portable Agent Context CLI and installer (ABR-73 / C2)

`agent_context_cli.py` is the **portable, reviewed CLI entrypoint**. C2 introduced `--help`, `--version` and read-only `validate`. C3 now extends the same entrypoint with `--topic`, `--path`, `--files-changed`, complete Markdown/JSON document rendering, recursive dependencies and `explain`. The CLI remains documentation-only and never runs an agent.

Run directly on any supported development host with Python 3.10+ and `PyYAML`/`jsonschema` installed: `python3 scripts/agent_context_cli.py validate` from the repository, or `python3 scripts/agent_context_cli.py --repo-root /path/to/checkout validate` from anywhere. The CLI searches the current directory and parents for the **nearest** `.agents/context.yaml` manifest, even when that project's schema is missing. Validation then reports the incomplete project instead of selecting an unrelated enclosing repository. `AGENT_CONTEXT_REPO_ROOT` is an explicit override and `--repo-root` takes precedence. Invalid explicit roots fail rather than silently selecting another checkout.

`install-agent-context.py` packages the **committed Git** copies of `agent_context_cli.py`, `context_contract.py` and `context_resolver.py` into a reproducible, single-file Python zipapp at `/opt/agent-tools/bin/agent-context` (external Python dependencies remain host-managed). It rejects uncommitted source changes, including Git `assume-unchanged` masking, and refuses unmanaged executables or unexpected edits. Installation replaces only that executable atomically; existing managed versions are backed up. The C3 installer recognizes previously reviewed two-module C2 zipapps so an explicit upgrade does not treat those managed artifacts as unknown.

- `python3 scripts/install-agent-context.py --validate` — read-only Git integrity / zipapp build check.
- `python3 scripts/install-agent-context.py --check` — read-only comparison to the installed CLI.
- `python3 scripts/install-agent-context.py --apply` — **explicitly install after the PR is merged**, from the reviewed Git checkout on Ubuntu.
- `agent-context --version` and `agent-context --repo-root /path/to/checkout validate` — verify the executable works outside the project directory after installation.

Run `python3 scripts/test_agent_context_cli.py` and `python3 scripts/test_install_agent_context.py` for isolation, source provenance, CLI and deployment tests. See [Context schema](../docs/blueprints/agent-context/CONTEXT_SCHEMA.md) and [Context implementation blueprint](../docs/blueprints/agent-context/README.md). This does not install third-party packages, modify runtime profiles, create credentials, enable dispatch, or restart services.

## Complete README retrieval and explanation (ABR-74 / C3)

`context_resolver.py` implements topic, nearest-owner path and Git changed-file selection using the v1 `.agents/context.yaml` manifest. It follows `context.requires` recursively, deduplicates documents, preserves every selected README in full, and emits deterministic dependency-first results with Git source SHA, actual source path, SHA-256, dirty-worktree indication and sorted inclusion reasons. Host README files must match their reviewed Git sources, and missing selected dependencies fail visibly; files without a matching changed-file owner appear under `unmatchedPaths`.

Supported commands include `agent-context --topic profiles`, `agent-context --path agents/registry.json`, `agent-context --files-changed`, `agent-context --topic profiles --format json`, `agent-context explain --topic profiles`, and `agent-context --path jobs/lifecycle/example.mjs --format json explain`. With no selector the default context entrypoint is retrieved. The `validate` command remains metadata-only, while `explain` shows provenance/reasons without document bodies. These commands work directly through `python3 scripts/agent_context_cli.py` before the approved C3 zipapp is installed.

For full semantics and the post-merge verification contract see [C3 resolver documentation](../docs/blueprints/agent-context/RESOLVER.md). Run `python3 scripts/test_context_resolver.py`, plus existing CLI and installer tests. C4 adds strict source-path protection and opt-in partial output for missing optional host documentation. C5 verifies complete cross-root retrieval and native Linux/macOS/Windows path behavior through a dedicated test matrix. The resolver does not execute README instructions or grant Bridge dispatch permissions.

## Strict filesystem and dependency boundaries (ABR-75 / C4)

The C1 metadata validator and C3 resolver now reject symlinks in selected source and manifest/schema paths, unsafe traversal, missing declared required roots, malformed metadata, and unknown/cyclic dependencies. The default CLI returns **no incomplete bundle** when selected documentation is unavailable. `--allow-partial` is an explicit exception for missing **optional host-root READMEs only**; its Markdown/JSON output identifies missing IDs, root aliases, expected paths, inclusion reasons and errors. It cannot hide unsafe paths, a missing required root, malformed metadata or a drifted host file. `validate --allow-partial` is rejected.

Run `python3 scripts/test_context_safety.py`, `python3 scripts/test_agent_context_cli.py`, `python3 scripts/test_context_resolver.py`, and `python3 scripts/test_context_contract.py`. See [C4 safety policy](../docs/blueprints/agent-context/SAFETY.md). After PR review and merge, update only the managed CLI using `scripts/install-agent-context.py --apply`, verify `--check`, then test both strict and opt-in partial modes against an approved checkout. The README content is never trimmed or executed.

## Cross-root deterministic acceptance (ABR-76 / C5)

`test_context_cross_root.py` exercises the complete Git `agents/` + three host-root README dependency graph using reviewed Git blobs copied to temporary, overridden host paths. The suite checks complete source bytes, Git SHA-256 attribution, stable dependency order, deduplication, path selectors, Git changed-file ownership, partial/strict missing-host behavior, duplicate YAML keys, actual dependency cycles, CLI JSON/Markdown determinism and a packaged zipapp invoked outside the checkout. Native OS tests and `select_host_root` cases verify Linux/macOS/Windows absolute paths while manifest document locators remain portable POSIX-relative strings. Scoped `.gitattributes` rules preserve LF bytes for the reviewed README and CLI modules, preventing checkout-time CRLF drift from being misreported as a source mutation.

Run `python3 scripts/test_context_cross_root.py` locally. The Agent Context GitHub Actions workflow runs the suite independently on Ubuntu, macOS and Windows with pinned dependencies and Git source line endings preserved. See [C5 acceptance contract](../docs/blueprints/agent-context/ACCEPTANCE.md). C5 tests documentation retrieval only and does not install a new CLI, change profiles, or run services.

## Shared coding-agent skill integration (ABR-77 / D1)

`test_agent_context_harnesses.py` validates that root `AGENTS.md`, Qwen's `QWEN.md` and the canonical `.agents/skills/agent-context/SKILL.md` point to **one** reviewed resolver. It exercises that resolver against the cross-root dependency graph with temporary Git-reviewed host documentation, including complete content and hashes. The same test runs in the CI native Ubuntu/macOS/Windows matrix. See [the harness contract](../docs/blueprints/agent-context/HARNESSES.md) for Codex, OpenCode, Qwen Code and Mistral Vibe skill invocation; no duplicated skill installation, host CLI reinstallation or agent process launch is part of D1.

## Host-only infrastructure

One-time Ubuntu `/opt` bootstrap, global permission changes, shared shell configuration, Volta rebuilds, and central CLI/profile installation scripts are **not** part of this recovery PR. Those belong to the separate host infrastructure ownership path. Never automatically copy or run those scripts on a live server as part of npm installation or CI.

`npm run types`, `npm run typecheck`, `npm run test:reliability`, `npm run bridge:test`, and `npm run registry:validate` are the primary verification commands.
