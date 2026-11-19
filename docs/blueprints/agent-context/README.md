# Agent Context System — corrected blueprint (uploaded research profile schema)

This is a portable source-based context system proposal. It contains templates, source references, bootstrap examples and implementation tasks; **it does not deploy an executable or change the running bridge**.

## Implemented ownership contract

[Git and /opt source-of-truth boundaries](OWNERSHIP.md) (ABR-60) specify which directories own source-controlled definitions, host runtime state, shared agent tools and general tooling. This is documentation-only; host bootstrap, resolver and runtime activation remain separate implementation tasks.

## Corrected profile contract

**ABR-62 catalog decision:** `agents/agent-registry.yaml` is now the **canonical current 15-entry research catalog**, with a matching profile in `agents/profiles/candidates/` for each ID. The two preserved catalogs under `references/` are historical snapshots: 14 entries at 13:10 PST and 15 entries at 14:58 PST on 2026-11-12. Only `colab-notebook-agent` was added; existing 14 entries have identical parsed content. Neither profile catalog is executable dispatch configuration.

The uploaded `agent-registry-schema.json` defines **one research profile entry**, with top-level `id`, `displayName`, `description`, `kind`, `provider`, `model`, `runtime`, `linearBridge`, `taxonomy`, `routing`, `execution`, `permissions`, and `security`. The uploaded `agent-registry-v2.yaml` is a catalog of 15 profiles; `agent-registry.yaml` is an older catalog of 14. The added ID in the first catalog is `colab-notebook-agent`. Both catalogs declare `version: 1.0.0` and both satisfy the uploaded entry schema.

The current Bridge `agents/registry.json` with `schemaVersion: 2` is **another, independent executable registry format**, with fields such as `profile`, `runtimeContract`, and `executionPolicy`. Its schema is `agents/registry.schema.json` in the Git repository. Its compatibility contract remains separate. Do not replace it with an uploaded research YAML file or use a thin `$ref` to it as a substitute for the user's profile schema.

## Package contents

- `templates/context/agent-profile.v2.template.yaml`: **corrected** complete candidate profile template conforming to the uploaded per-entry schema.
- `templates/context/agent-profile.entry.schema.json`: **canonical, editable research-entry schema**, validated byte-for-byte against the pre-existing compatibility mirror at `agents/agent-registry-schema.json`; only the template copy is maintained as schema source.
- `templates/context/agent-registry.catalog.template.yaml`: example catalog wrapper; the attached schema validates *entries*, not the wrapper.
- `templates/context/bridge-runtime-registry.v2-entry.template.json`: separate *Bridge-specific* runtime registry example, originally misidentified as the NotebookLM profile template.
- `templates/context/profile-mapping.md`: review-gated mapping between research profiles and executable Agent Registry v2.
- `templates/context/README.template.md` and `context-frontmatter.schema.json`: README metadata and documentation structure.
- `templates/context/host-root.README.template.md`: root README for `/opt/agents`, `/opt/agent-tools`, `/opt/global-tools`.
- `.agents/README.md` and `.agents/context.yaml`: **installed Git bootstrap documents (ABR-66)**; root `AGENTS.md` now contains the **B2 bootstrap instructions (ABR-67)**. The proposed `agent-context` skill remains staged in `bootstrap/` for Milestone D1.
- `agents.README.context-starter.md`, `bridge/README.context-starter.md`: staged reference fragments; their frontmatter is now merged into the **existing** owning READMEs under ABR-68 without replacing their contents.
- `IMPLEMENTATION_TASKS.md`: milestones and tests (PostgreSQL UI excluded).
- `references/`: exact attached 14- and 15-agent research catalog snapshots for historical comparison. The existing `agents/agent-registry-schema.json` remains a checked compatibility mirror of `templates/context/agent-profile.entry.schema.json`; validation rejects divergence.

## Host runtime inventory (ABR-63)

[Staged Ubuntu harness inventory and reconciliation](RUNTIME_INVENTORY.md) documents the verified installed CLI paths, the Git-owned source at `templates/context/agent-runtimes.staged.json`, and the guarded `scripts/reconcile-agent-runtimes.py` command. This is **not** an executable agent registry and does not enable dispatch. Applying the reviewed staged snapshot to `/opt/agents/registry/agent-runtimes.json` is a separate, deliberate host operation following review and merge.

## Research-to-runtime promotion (ABR-64)

The [review-gated promotion contract](PROMOTION.md) and `scripts/review-research-promotion.py` provide an **offline, proposal-only** translation from research `AgentRegistryEntry` plus explicit reviewed evidence into separate Registry v2 entry JSON. Real PR approval, provider verification, and deployment are external to the tool. Candidate profiles never become executable automatically.

## Template defaults and historical CLI examples

The profile template deliberately uses `maxRetryAttempts: 0` (no automatic retries until a provider retry policy is tested). It uses the installed OpenCode CLI's `--session` continuation flag; historical research catalogs mention `--session-id`, which is not the installed OpenCode v1.19.5 syntax. Keep research snapshots unchanged as evidence rather than treating their command strings as executable.

## Per-profile version policy

[ABR-65 research profile version policy](PROFILE_VERSION_POLICY.md) keeps `profileVersion` undefined and rejects implicit additions in profile inputs, research schemas and promotion proposals. Introducing it later requires a separately reviewed schema migration, compatibility plan and dedicated tests. This is distinct from the research catalog `version`, Bridge Registry `schemaVersion` and README frontmatter version.

## Project-local bootstrap (ABR-66)

The Git-root [`.agents/README.md`](../../../.agents/README.md) and [`.agents/context.yaml`](../../../.agents/context.yaml) now declare the context entrypoint and optional host aliases. They are **metadata only**: the resolver, harness skill, and deployment integration remain future tasks, and the existing `.agents/skills/` contents are preserved. The validator checks bootstrap frontmatter, root-relative document paths, aliases, and entrypoints. READMEs and frontmatter owned by other folders are introduced separately under B3/B4.

## Agent instructions (ABR-67)

Root [`AGENTS.md`](../../../AGENTS.md) now directs agents to read the project-local context README and manifest before code edits, identify relevant owning README dependencies, and use the shared resolver when it becomes available. Until then, dependency documents are inspected manually. No command is represented as installed before Milestone C.

## Owning README context frontmatter (ABR-68)

Existing [`agents/README.md`](../../../agents/README.md) and [`bridge/README.md`](../../../bridge/README.md) now publish their context IDs, profile/dispatch/deployment topics, document applicability, and dependencies on the repo registry and three optional `/opt` documentation roots. Their original implementation instructions remain intact. The validator checks these IDs against `.agents/context.yaml`, schema-valid frontmatter, and dependency aliases; host-root README files themselves arrive in B4.

## Ubuntu host-root READMEs (ABR-69)

The three reviewed, non-secret [host-root README sources](../../../templates/context/host-roots/README.md) define `host.agent-runtimes`, `host.agent-tools` and `host.global-tools`. A guarded `scripts/reconcile-host-root-readmes.py` supports source validation, read-only host comparison and explicit post-review install with backups. Git source files do **not** automatically populate `/opt`, enable the resolver or alter services.

## Memory and integration ownership (ABR-70)

Git READMEs in [`memory/`](../../../memory/README.md) and [`integrations/`](../../../integrations/README.md), plus their actively modified nested folders, now document checkpoint, provider and external API ownership. Their context IDs are registered in `.agents/context.yaml` and tested for complete source paths, declared cross-folder dependencies, and cycles. Metadata never authorizes database operations or provider dispatch.

## Reusable template publication (ABR-71)

The Git-owned [`templates/context/`](../../../templates/context/README.md) tree now has a versioned publisher at `scripts/publish-context-templates.py` for managed copies under `/opt/agent-tools/templates/context/`. The publisher verifies SHA-256 descriptors and recorded source revision, refuses unmanaged drift, and keeps a previous installed snapshot when a reviewed version changes. `--validate` and `--check` are read-only; host installation requires explicit post-merge `--apply`. The installed files remain inert templates; Milestone C owns the actual resolver.

## Context metadata and root aliases (ABR-72)

The [Context v1 schema policy](CONTEXT_SCHEMA.md) establishes the formal JSON Schemas for README YAML frontmatter and `.agents/context.yaml` root/document aliases, including cross-platform environment and OS-specific root defaults. The reusable Python validator rejects duplicate IDs, unsafe paths, missing references and dependency cycles while reading only Git-owned source READMEs. The `jobs/README.md` now has validated context frontmatter. This adds no running resolver or CLI agent privileges.

## Portable Context CLI bootstrap (ABR-73)

The source-controlled `scripts/agent_context_cli.py` exposes `--help`, `--version` and `validate` using the reviewed C1 contracts; it discovers a project manifest from the working directory or an explicit root. A guarded `scripts/install-agent-context.py` builds a deterministic, source-verified single-file Python zipapp for deliberate post-merge installation at `/opt/agent-tools/bin/agent-context`, with backup and read-only check modes. C2 introduced the CLI entrypoint and validation path. ABR-74 (C3) adds selection, recursive retrieval, provenance and rendering; C4/C5 continue live filesystem hardening and acceptance tests.

## Source-linked context resolution (ABR-74)

The [C3 resolver contract](RESOLVER.md) implements `--topic`, `--path`, `--files-changed`, `--format markdown|json`, `validate` and `explain` through the same portable `agent-context` CLI. Dependencies are traversed recursively, emitted once in deterministic dependency-first order and accompanied by actual source paths, Git SHAs, content hashes and reasons. README bodies are preserved without trimming. The Git-reviewed C3 zipapp source now includes `scripts/context_resolver.py`; its installer recognizes the C2 two-module format for controlled upgrades. C4 hardens path isolation and optional partial results; C5 independently verifies cross-root and native cross-platform acceptance.

## Required roots and partial-output safety (ABR-75)

The [C4 safety contract](SAFETY.md) hardens the C1/C3 validators and resolver against symlink escapes, traversal, malformed metadata, required-root absence and silently omitted documentation. Context resolution is strict by default; `--allow-partial` only permits explicitly reported missing optional host-root documents, preserving every returned README in full and recording each omission's ID, path and reason. This does not grant filesystem or execution permissions to a research profile or agent.

## Cross-root acceptance and deterministic retrieval (ABR-76)

The [C5 test contract](ACCEPTANCE.md) verifies complete, source-linked context retrieval across Git `agents/` and the three optional host roots, even when each root is overridden to a disposable directory. Checks cover deterministic order/JSON/Markdown, original README bytes, Git SHA/content hashes, missing host files, real dependency cycles, changed-file ownership, and native Linux/macOS/Windows paths. CI runs the same isolated suite on all three OS runners. This milestone adds tests and documentation, not new agent execution or a service deployment.

## Shared coding-harness context entrypoint (ABR-77)

The Git-owned [canonical project skill](../../../.agents/skills/agent-context/SKILL.md) and root [AGENTS.md](../../../AGENTS.md) now direct coding/review agents to the already-reviewed `agent-context` resolver before edits. [QWEN.md](../../../QWEN.md) provides Qwen Code's project instruction entrypoint without copying the skill. Codex, OpenCode, Qwen Code and Mistral Vibe discover the same `.agents/skills/agent-context/SKILL.md`; native invocations and limitations are documented in [HARNESSES.md](HARNESSES.md). The CI harness tests exercise actual read-only retrieval and source provenance, not runtime model launches or additional dispatch authority.

## Research execution authority boundary (ABR-78 / D2)

The [D2 authority contract](RESEARCH_AUTHORITY.md) separates candidate research/profile data, code-signature/model/host claims, and context bundles from real Registry v2/Worker identity, authenticated Bridge job admission, and runtime enforcement. A focused CI gate checks that executable Bridge and Worker sources do not import research/context proposals; fake-candidate tests demonstrate that catalog permission claims cannot mint Worker identities, while reviewed promotion remains non-installing. This milestone does not assert that cryptographic code-signature validation or live model allowlist enforcement has been added to a runtime.

## Same-PR nearest-owner README discipline (ABR-79 / D3)

[README_DISCIPLINE.md](README_DISCIPLINE.md) documents the new PR-wide CI check for behavioral source changes. It selects the nearest existing tracked README from each file's directory ancestry, requires a same-PR effective README update, and explains narrow research/profile data, test and documentation exemptions. New folders without an owner are reported for D4 coverage rather than triggering a repository-wide rewrite. The checker uses PR merge-base/head Git history, does not change Bridge runtime, and cannot grant execution privileges.

## Ownership and use

Git project `templates/context/` is the reusable source. A setup tool can install reviewed copies at `/opt/agent-tools/templates/context/`, while project-specific files live in `.agents/`. Runtime private settings remain under `/opt/agents/` and shared general tools under `/opt/global-tools/`.

After reviewing and installing the C3 executable, use the supported selection and explanation commands shown in [RESOLVER.md](RESOLVER.md). These options retrieve documentation only and do not authorize agent execution, production changes or access to credentials.