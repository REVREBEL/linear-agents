# Repository scripts

This directory contains **versioned project commands and their tests**. It is not a deployment destination for machine-global CLI installation, private agent profiles, host credentials, or `/opt/agents` runtime state.

## ABR-92 verified promotion prerequisite

`scripts/memu-promote.mjs` now refuses unauthenticated standalone preparation: its JSON evidence is not trustworthy authorization. The installed core `memu` CLI has no `memorize prepare` command; read-only GitHub review and CI verification is implemented in `memory/promotion-verification.mjs`, but no evolve or commit executor is enabled. See [ABR-92 gate and activation prerequisites](../docs/ABR92_PROMOTION_GATE.md).

## ABR-59 read-only scoped PostgreSQL diagnostic

Run `node scripts/check-scoped-memu-read.mjs` **as the bridge user** on the approved Ubuntu host. This executes a bounded, read-only, SQL-level user/agent scoped query using a reserved synthetic scope and asserts no recall content is returned. It never prints memory or modifies the live DB. See [M5 authorized read contract](../docs/ABR59_AUTHORIZED_READ.md).

## ABR-59 disposable memU commit/retrieval canary

Run `TMPDIR=/var/tmp node scripts/memu-disposable-canary.mjs` **as the bridge user** on Ubuntu, not as root. This creates a private disposable SQLite database, commits one synthetic memU learning through the installed native CLI and tests its later retrieval, then deletes the temporary files; it does not touch `agent_memory`. This is not a production authorization or four-field isolation test. See [ABR-59 M4 contract](../docs/ABR59_COMMIT_EXECUTOR.md).

## ABR-59 host memU runtime verification

`node scripts/check-memu-runtime.mjs` is a **read-only, host-specific** diagnostic; run under the Bridge service account. It checks the private host config, approved absolute memU binary and local PostgreSQL pgvector version, stored-vector dimensions and aggregate counts without printing database DSNs, API keys or session content. It does not activate memory retrieval or mutation. See [ABR-59 runtime contract](../docs/ABR59_MEMU_RUNTIME.md).

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

## Same-PR owning README enforcement (ABR-79 / D3)

`check-pr-readme-updates.py` enforces an incremental behavioral-source documentation policy against the **effective Git PR diff** (`--base BASE_SHA --head HEAD_SHA`). For each changed code, configuration, schema, migration or project-local agent skill file, it selects the nearest **tracked local README** by directory ancestry and requires that README to be changed in the same PR. Renames, deletions and removed README owners are handled explicitly. Research/candidate YAML data, test-only changes and ordinary documentation/static files have fixed, logged exemption reasons; an exemption cannot waive a mixed PR's behavioral changes. Paths without a local README are printed as D4 coverage advisories, not silently assigned to the repository root.

The [README discipline policy](../docs/blueprints/agent-context/README_DISCIPLINE.md) defines ownership, exemptions and scope. Run `python3 scripts/test_pr_readme_updates.py` for fixture regressions, and `python3 scripts/check-pr-readme-updates.py --base BASE_SHA --head HEAD_SHA` to check an actual PR. The dedicated GitHub Actions workflow runs on every PR with read-only permissions and the full Git graph. This is CI/source documentation enforcement only; no native agent, host installation or service changes.

## README coverage inventory and broken-local-link report (ABR-83 / D4)

`report-readme-coverage.py` reads committed Git tree objects to inventory every folder with tracked files, find folders without their own `README.md`, and validate relative Markdown/HTML links within tracked READMEs and canonical Agent Context documentation. The scanner uses the same behavioral-file classification as D3 and records broken references with source paths and line numbers. It is advisory: it does not make existing README gaps or broken links fail CI. Run `python3 scripts/test_report_readme_coverage.py` and `python3 scripts/report-readme-coverage.py --format json`; the [README Coverage Inventory workflow](../.github/workflows/readme-coverage-inventory.yml) uploads current Markdown/JSON reports on every PR and push to main. See [D4 guide](../docs/blueprints/agent-context/README_COVERAGE.md) and [historical baseline](../docs/blueprints/agent-context/README_COVERAGE_BASELINE.md). No services or host profiles are scanned or changed.

## Versioned context handoff messages (ABR-84 / D5)

`agent-context-handoff.py` wraps the **existing reviewed context resolver** and emits a self-contained versioned Markdown or JSON agent handoff containing original instruction, complete README bodies and dependency provenance, pinned Git HEAD, per-source Git SHAs and hashes, and canonical message/bundle/envelope hashes. `verify --input FILE --repo-root CHECKOUT --check-source` replays the complete selected seeds and dependencies from pinned Git metadata, verifies document order, inclusion reasons and unmatched-path evidence, and validates exact source bytes and manifest ownership independent of the sender's host directories. It rejects omitted selected leaves even when an altered bundle carries recomputed hashes. A dirty README, missing content, digest mismatch or incomplete dependency fails; optional missing host documents require explicit `--allow-partial` on both ends. The tool neither dispatches nor authorizes an agent and is not installed as a new host executable. See [D5 handoff contract](../docs/blueprints/agent-context/HANDOFFS.md) and run `python3 scripts/test_context_handoff.py` for replay and tamper regressions.

## Qwen Local E1 Agent Context pilot (ABR-85)

`test_qwen_local_context_pilot.py` verifies the standalone Qwen Local research candidate matches the 16-entry canonical catalog and separate schema, the isolated OpenCode 1.x example only permits local `ollama/qwen3.5:9b-opencode`, and a D5 full-context handoff replays against the pinned Git source without original host paths. It also enforces that the candidate is **not** silently added to executable Registry v2. See [E1 pilot evidence](../docs/blueprints/agent-context/QWEN_LOCAL_PILOT.md) for blocked live headless execution and missing Qwen Worker readiness. Run `python3 scripts/test_qwen_local_context_pilot.py`; CI runs the same test. This is a non-dispatching context/source regression.

## Fresh-session six-root context acceptance (ABR-86 / E2)

`test_context_fresh_session.py` launches new Python CLI processes from unrelated directories and checks the exact six-document `--topic jobs` dependency graph, full README bodies, SHA-256 and Git provenance, deterministic replay, strict missing-host failure, explicit partial policy and D5 source-pinned handoff verification after the disposable host files disappear. Fixtures use Git-reviewed host template README bytes; native Ubuntu/macOS/Windows CI verifies portability. The [E2 acceptance guide](../docs/blueprints/agent-context/FRESH_SESSION.md) includes a successful live Ubuntu host test and the one-line command. This does not invoke providers, dispatch agents or install host tools.

## E3 context-to-memory authority boundary (ABR-87)

`memory/context-memory-isolation.test.mjs` runs fake PostgreSQL scoped CAS, memU recall, local task preparation and a real README context CLI invocation in disposable directories. It proves that context retrieval cannot initiate memU or become canonical promotion evidence, and that the optional recall path rejects incomplete and mismatched agent/issue/repository/tenant scopes. The [E3 evidence and limitations](../docs/blueprints/agent-context/MEMORY_ISOLATION.md) distinguish source-level guards from live memU storage isolation. CI runs this with the existing memU and checkpoint tests. No DB, agent CLI or service changes are performed by the tests.

## Independent repository portability acceptance (ABR-88 / E4)

`test_context_second_repo.py` creates a fresh TypeScript/Next.js Git repository using the reviewed `docs/blueprints/agent-context/examples/nextjs-app/` example, copies the portable C1–C5 Python CLI modules and v1 JSON schemas, then runs independent project discovery, four-document retrieval, SHA/source integrity, nearest-owner and changed-file selection, strict/partial host behavior, and pinned D5 handoff verification after host-root deletion. The [E4 live pilot report](../docs/blueprints/agent-context/SECOND_REPOSITORY_PILOT.md) also records a successful disposable clone of an existing unrelated Payload/Next.js codebase. It does not install application packages, execute Workers or alter the real second checkout.

### E4 Kilo review follow-up (ABR-88)

The independent-repo fixture now reads **all** source-controlled examples, CLI modules, and schemas from the Git object database so Windows CRLF working-copy conversions cannot alter the canonical bytes under test. `context_contract.py` uses the validated fixed reviewed source for legacy host aliases, explicitly rejects a separate `source` field on repository-owned documents, and emits an actionable error. `context_resolver.py` indexes portable source-backed host metadata only for non-repository locators. `test_context_contract.py` covers matching and mismatched legacy aliases and forbidden repository source overrides.

## Versioned source-linked static README documentation (ABR-89 / E5)

`build_context_docs_site.py` creates a separate static HTML site from **every Git-tracked README.md at pinned HEAD**, including full original Markdown blobs, safe rendered HTML and a versioned `provenance.json` containing Git HEAD/tree, per-document blob/last-changing commit, full SHA-256, original paths and immutable GitHub links. It reads Git objects, not checkout edits or private /opt roots. `build --output PATH` requires a new path outside the checkout; `check --output PATH` compares the complete manifest, rendered pages and raw content byte-for-byte without modifying them. The [E5 documentation site contract](../docs/blueprints/agent-context/PROVENANCE_SITE.md) records standalone operation, CI artifacts and review boundaries.

`python3 scripts/test_context_docs_site.py` exercises fourteen independent Git fixture acceptance cases, including safe Markdown and GitHub-style heading anchors, provenance, deterministic site replay, changed-source invalidation and output tampering. The [README site Actions workflow](../.github/workflows/agent-context-docs-site.yml) runs tests and uploads a SHA-named, 30-day downloadable HTML site artifact with read-only contents permissions. It does not modify the repository, host an external site, publish to Pages, install a provider or deploy a bridge service.

## Host-only infrastructure

One-time Ubuntu `/opt` bootstrap, global permission changes, shared shell configuration, Volta rebuilds, and central CLI/profile installation scripts are **not** part of this recovery PR. Those belong to the separate host infrastructure ownership path. Never automatically copy or run those scripts on a live server as part of npm installation or CI.

`npm run types`, `npm run typecheck`, `npm run test:reliability`, `npm run bridge:test`, and `npm run registry:validate` are the primary verification commands.

## Remote MCP foundation smoke (ABR-94)

`test-mcp-foundation.mjs` exercises the isolated loopback MCP HTTP+WebSocket relay/host pairing with authorized UTF-8 file reads, negative device/path/symlink/secret tests, denied privileged tools and no external egress; `test-mcp-source-audit.mjs` verifies upstream SHA/bytes evidence and the complete [30/42/3 machine-readable tool catalog](../docs/audits/mcp/tool-parity.json). Run `node --test scripts/test-mcp-foundation.mjs scripts/test-mcp-source-audit.mjs` with locked root dependencies. Neither script invokes a live Bridge service, external identity system or production port. The isolated [ABR-94 audit guide](../docs/audits/mcp/README.md) defines remaining authorization/compatibility milestones.

## MCP OAuth and protocol acceptance (ABR-95)

`test-mcp-oauth.mjs` and `fixtures/oauth-local-issuer.mjs` provide a disposable, offline ES256 PKCE/OIDC authorization-server fixture for validating the real local MCP *resource server*. They test registration redirect allowlists, PKCE S256, state/consent, resource indicators, one-use codes and refresh rotation, token revocation, signed issuer/audience/client/device/tool scope checks, public protected-resource discovery and modern/legacy MCP wire negotiation. Invoke `node --test scripts/test-mcp-oauth.mjs`. The fixture cannot be used for actual user login, issuing production OAuth tokens or deploying Cloudflare; read the [ABR-95 security and rollback contract](../docs/audits/mcp/OAUTH_EDGE.md).

## ABR-96 — Ubuntu process and job confinement checks

`test-mcp-executor.mjs` uses disposable workspaces/SQLite journals and server-minted execution scopes to check real Linux Bubblewrap isolation, exact stderr/stdout/exit code, process-tree timeouts, Python REPL input/prompt, resource and secret caps, SQLite idempotency, fair job scheduling, reconnect, cancellation, deterministic refusal of queued writes after capability expiration or revocation, atomic rejection of oversized parallel batches with no partial execution, stable stdout/stderr cursors after a Python REPL prompt, and release of active slots after process completion. `mcp-executor-probe.mjs --strict` checks that **the actual OS identity** has permission for user namespaces. On the current server, `bridge` UID 994 fails this check due to AppArmor policy, and tests run elevated solely as isolated proof; the code never falls back to host execution. The in-flight revocation regression synchronizes on a child-created ready marker and a withheld release gate, rather than assuming a one-second sleep; it verifies a cancelled process never writes after the gate is released. `mcp:executor:test` runs the suite; [source-only readiness and rollback](../docs/audits/mcp/EXECUTOR.md) explain the approval gate.

## ABR-97 — Mac SSH identity probe and dual-host scope tests

`mcp-macos-probe.mjs` uses only strict, pre-trusted SSH to inspect the actual macOS `io.revrebel.agent-bridge` launchd identity, NVM Node and repository-derived projects root. It performs no install, key generation or command execution other than fixed read-only discovery. `test-mcp-device-routing.mjs` covers offline two-device enrollment, Ed25519 one-time pairing, audited approval/denial, rotation, revocation, reconnection and interactive-vs-Linear host selection with no fallback. The pairing tests include deterministic **two-instance SQLite challenge replay** and replacement-during-verification cases, alongside revocation-during-verification; a stale signed proof must fail after another trusted instance consumes or changes its challenge. Run `npm run mcp:devices:test`; for an operator-run Mac check use `node scripts/mcp-macos-probe.mjs`. See [ABR-97 host audit](../docs/audits/mcp/MACOS_HOST.md).

## ABR-98 — Profile/schema benchmark, scoped Git/AST and PDF tests

`test-mcp-profiles.mjs` asserts exact 30/42/3 inventory counts, core/focused/full discovery, hidden-name invocation permission, denied plugin/transfer/admin calls, standalone signed OAuth integration and deterministic REPL prompts. `test-mcp-structure.mjs` tests actual sandboxed Git and Babel AST search/dry-run/controlled fixture edits with SHA-256 conflicts. `test-mcp-documents.mjs` tests Chrome-free offline PDF bytes, pagination, insert/delete, preserved originals and separate document-write grant. Use `npm run mcp:profiles:test`, `npm run mcp:profiles:benchmark` for representative schema bytes/token estimates and local list latency. Review regressions also verify five Git-applied unified patches (trailing newline, no final newline, CRLF, untouched EOF context), ambiguous AST rewrite refusal despite `maxResults: 1`, literal Git pathspec bounds, and a single JWT signature verification per OAuth request with private grant/revocation checks. No full 30-tool golden parity or production handler activation is claimed; see [ABR-98 acceptance](../docs/audits/mcp/PROFILES.md).

## ABR-99 — Canonical Bridge MCP milestone and review pipeline tests

`test-mcp-bridge-integration.mjs` exercises the actual disposable `jobs/persistence/job-store.mjs`, `memory/active-task-memory.mjs` and `bridge/orchestration/review-inbox.mjs` together. It proves strict trusted-job session/host/repository/tenant matching, tool-receipt validation, bounded/redacted checkpoint CAS, persistent dedupe after progress eviction, concurrent updates, stale denial, D5 full context verifier opt-in and durable PR-head review queue/ACK distinction. Mocked submission/PR-verification clients are **test-only injected fixtures**; no production ABR-17 coordinator, EventIntelligence wakeup or live Linear/GitHub/Worker write is present. Run `npm run mcp:bridge:test` and independently `python3 scripts/test_context_handoff.py` for the actual D5 pinned source verifier. See [ABR-99 acceptance](../docs/audits/mcp/BRIDGE_INTEGRATION.md).

ABR-99 review regressions verify D5 caller mutation during verification and attempted mutation after return, plus six truncation-boundary receipt cases with byte-identical persisted summaries, intact redaction markers, stable duplicate results and unchanged CAS revisions.

## ABR-17 M1

`npm run submission:test` exercises the actual canonical job ledger and SQLite submission effect journal using test-only publication adapters. Cases include concurrent connections, lost responses/restart at all six external stages, wrong admission, Git/CI refusal, same-head retries and same-PR revisions. No live providers or credentials are used.

ABR-17 authorization race regression: deterministic held ledger reads exercise revocation and expiry at all eight submission lookups, both recovery lookups and initial handle minting.

## ABR-17 M2 — Private submission CLI and fixtures

`submit-work.mjs <issue-id> <summary>` requires trusted launcher-inherited duplex FD 3. No credentials, host URL or job ID are accepted in args/environment. `npm run submission:m2:test` checks the real child IPC path, scoped capabilities and revocation across M1, signed mocked GitHub broker exchanges, and actual Linux-confined Git reads against disposable fixtures. Provider deployment and linked worktree/Mac support remain gated.

## ABR-17 M3 — Provider adapter regressions

`npm run submission:m3:test` covers actual HTTP/GraphQL client request construction with signed fixture keys and simulated provider responses, durable PR reuse, draft/manual-ready recovery, lost responses at all external API stages, exact Linear actor/session/activity attribution, stale-head rejection, closed prior PR refusal, route denial and explicit failed/blocked Worker completion. The real disk-backed outbox and inbox are used. No live provider requests.

## ABR-17 M4 — Managed finish tests

`npm run submission:m4:test` exercises actual submit-work child IPC with mocked AGY, Trae and OpenCode launchers and M3 fixed-endpoint provider fixtures, shared real canonical ledger/outbox/inbox, explicit terminal outcomes, wrong-issue/stale submission, and ABR-99 source callback without duplicate reviewer queueing. This is not a native process isolation proof. The CLI returns nonzero for denied or pending handoff.

M4 regressions also verify actual confined final-head capture, managed duplicate acceptance, checkout launch exclusion, and the AGY Python wrapper's private FD propagation and suppression of legacy Worker calls.

Legacy AGY quota retry recovery remains per-record, independent of managed submission enablement. Managed waiting-quota records never resume via the legacy timer; both startup and timer execution use the same predicate.

## ABR-17 M5 — Host evidence and operator recovery

`submission-host-readiness.py` is a read-only host report with exact service-UID sandbox probe and native discovery; it deliberately cannot authorize activation. `recover-managed-submission.mjs JOB_KEY APPROVAL_ID` requires the installed protected operator binding, inactive service, service UID, exclusive lease and verified quiescence. It only reconciles observed pending effects. `npm run submission:m5:test` requires a disposable Linux fixture host with supported Bubblewrap; tests include cross-process lock/crash, real sandboxed private FD CLI, secret-sentinel and network isolation, lost-response and terminal receipt recovery. No live provider writes or service changes.

M5 approved host remediation: install only the reviewed packaged Bubblewrap
policy unit (see scripts/linux/README.md); readiness now resolves the real
running Node executable or accepts an explicit installed binary via --node,
and runs with the actual service UID and clean HOME. The M5 command canary
mounts a pinned read-only fixture copy, not the CI checkout path. The strict
executor REPL assertion uses a bounded 2-second prompt deadline. All 57
executor/structure/M2/M5 tests passed as bridge UID 994, using a private
temporary fixture directory.
