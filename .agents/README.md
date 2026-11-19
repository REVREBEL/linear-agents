---
context:
  id: repo.bootstrap
  version: 1
  title: Agent Bridge context navigation
  topics: [bootstrap, context, documentation]
  requires: [repo.agents, repo.bridge]
  applies_to: [".agents/**", AGENTS.md]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Agent context bootstrap

This directory owns the **project-local context entrypoint**, not agent execution or authorization. Start with the existing root [`AGENTS.md`](../AGENTS.md) for operational guardrails; use [`context.yaml`](context.yaml) as the planned document/root alias map. The C2 `agent-context` CLI provides metadata validation; C3 adds topic/path/changed-file selection, recursive README retrieval and source-linked explanations. C4 strengthens live filesystem protection and introduces explicitly reported partial results for missing optional host documentation; C5 adds host acceptance tests, while D owns harness integration. The manifest is never executable authority.

## Ownership

- `context.yaml` declares `contextVersion: 1`, logical document IDs, optional host-root aliases, and future entrypoints. Its relative repository paths are resolved from the **project root** (parent directory of `.agents/`), never an arbitrary command working directory.
- The existing [`skills/`](skills/) directory remains independently owned. Adding context documentation does not replace, remove, or activate any skill. The proposed `agent-context` skill is [staged in the blueprint](../docs/blueprints/agent-context/bootstrap/.agents/skills/agent-context/SKILL.md) for Milestone D1.
- [`../templates/context/`](../templates/context/) holds portable README/context templates under Git review. [`../docs/blueprints/agent-context/`](../docs/blueprints/agent-context/) records the implementation plan and source-of-truth boundaries.

## Document readiness

The `repo.bootstrap`, `repo.agents`, `repo.bridge`, and `repo.jobs` document paths currently exist in Git. The owning `agents/` and `bridge/` READMEs now declare their `context` frontmatter under ABR-68 (B3), including references to optional host roots. The three optional host-root README paths have reviewed Git **sources** under `templates/context/host-roots/` (ABR-69, B4). Each real host must apply those sources explicitly after review; the README paths must not be assumed installed on every machine.

The C3 resolver returns full source-attributed README content for requested documents and visibly rejects unavailable selected dependencies. C4 rejects unsafe path and dependency metadata, with `--allow-partial` only for explicitly reported missing optional host roots; C5 adds native Linux/macOS/Windows cross-root acceptance tests. README text and research profiles are never executable authority. Onboarding a new host must not commit native CLI sessions, credentials, or private state.

## Memory and integration owners (ABR-70)

The context manifest also maps the Git-owned memory and integration READMEs: `repo.memory`, `repo.memory.migrations`, `repo.memory.scripts`, `repo.integrations`, `repo.integrations.litellm`, and `repo.integrations.openrouter`. These document active implementation boundaries but are not runtime instructions or an installed resolver.

## Shared context template publication (ABR-71)

The reusable Git source set `../templates/context/` is published only through the reviewed `scripts/publish-context-templates.py` installer. After merge, run `--apply` explicitly on Ubuntu and verify `--check` against `/opt/agent-tools/templates/context/`. The managed snapshot includes `.managed-context.json` for version/hash provenance and is not a runtime configuration or an available `agent-context` command.

## Context metadata schemas (ABR-72)

This manifest and its README headers now follow the versioned `templates/context/context-manifest.schema.json` and `context-frontmatter.schema.json` contracts. The Git-owned `scripts/validate-context-contract.py` checks document ID uniqueness, declared dependencies/cycles, safe relative paths and platform-aware root override semantics. A named `AGENT_CONTEXT_*_ROOT` environment override takes priority over an optional platform default, then the declared root default; the path must be native absolute and validation does not create missing host directories. The [schema policy](../docs/blueprints/agent-context/CONTEXT_SCHEMA.md) documents portability and boundaries. The C3 resolver provides read-only documentation retrieval; remaining C4/C5 hardening and harness integrations are separate milestones.

## Portable context CLI (ABR-73 / C2)

Use `python3 scripts/agent_context_cli.py validate` from the repository (or `--repo-root PATH validate` from another working directory) for the v1 manifest and 13 README source contracts. After review/merge, the guarded `scripts/install-agent-context.py --apply` installs a deterministic `/opt/agent-tools/bin/agent-context` zipapp on Ubuntu; verify with `--check` and then `agent-context --version`. The command uses host Python dependencies and does not run or dispatch agents. C3 adds `--topic`, `--path`, `--files-changed`, `--format markdown|json` and `explain` to the same CLI.

## README context retrieval (ABR-74 / C3)

The shared [`context_resolver.py`](../scripts/context_resolver.py) now selects declared owning documents and recursively includes dependencies in deterministic order. Run `python3 scripts/agent_context_cli.py --topic profiles` or `--path agents/registry.json` from Git, or use `--files-changed` to resolve README owners for Git changes (reporting files with no owner). `--format json` gives untruncated machine-readable content; `explain --topic profiles` reports inclusion reasons and Git provenance without the bodies. After merge, explicitly install the reviewed C3 zipapp to the same `/opt/agent-tools/bin/agent-context` path. See [C3 resolver reference](../docs/blueprints/agent-context/RESOLVER.md).

## Filesystem safety and partial results (ABR-75 / C4)

The resolver refuses missing required roots, path traversal, symlinked source paths, invalid or cyclic dependencies, duplicate IDs and malformed context metadata. It normally fails when any selected dependency is unavailable. Use `agent-context --topic profiles --allow-partial --format json` **only when a deliberately incomplete bundle is acceptable**: `partial: true` and `missingDocuments` disclose missing optional host READMEs, while full available documents remain untrimmed. Unsafe sources or invalid metadata are never suppressed. See the [safety contract](../docs/blueprints/agent-context/SAFETY.md).

## Cross-root acceptance (ABR-76 / C5)

The [C5 acceptance suite](../docs/blueprints/agent-context/ACCEPTANCE.md) verifies the full `repo.agents` / `repo.bridge` and `host.agent-runtimes`, `host.agent-tools`, `host.global-tools` graph with deterministic dependency order, exact Git-linked README content, root overrides, missing-file reporting, real fixture dependency cycles and portable path behavior. GitHub Actions runs `scripts/test_context_cross_root.py` on Ubuntu, macOS and Windows. No native CLI profile or running Bridge agent is part of these tests.

## Update discipline

Update this README and its manifest together when document IDs, aliases, source paths, dependencies, or bootstrap semantics change. Update nearest owning READMEs in the same PR as behavioral, configuration, security, routing, or deployment changes. Context metadata does **not** authorize filesystem access, credential use, code execution, or deployments.
