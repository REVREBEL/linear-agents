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

This directory owns the **project-local context entrypoint**, not agent execution or authorization. Start with the existing root [`AGENTS.md`](../AGENTS.md) for operational guardrails; use [`context.yaml`](context.yaml) as the planned document/root alias map. The C2 `agent-context` CLI bootstrap provides **metadata validation only**. Recursive context selection, full-source retrieval and harness integrations remain separate C3–C5 and D milestones; the manifest is never executable authority.

## Ownership

- `context.yaml` declares `contextVersion: 1`, logical document IDs, optional host-root aliases, and future entrypoints. Its relative repository paths are resolved from the **project root** (parent directory of `.agents/`), never an arbitrary command working directory.
- The existing [`skills/`](skills/) directory remains independently owned. Adding context documentation does not replace, remove, or activate any skill. The proposed `agent-context` skill is [staged in the blueprint](../docs/blueprints/agent-context/bootstrap/.agents/skills/agent-context/SKILL.md) for Milestone D1.
- [`../templates/context/`](../templates/context/) holds portable README/context templates under Git review. [`../docs/blueprints/agent-context/`](../docs/blueprints/agent-context/) records the implementation plan and source-of-truth boundaries.

## Document readiness

The `repo.bootstrap`, `repo.agents`, `repo.bridge`, and `repo.jobs` document paths currently exist in Git. The owning `agents/` and `bridge/` READMEs now declare their `context` frontmatter under ABR-68 (B3), including references to optional host roots. The three optional host-root README paths have reviewed Git **sources** under `templates/context/host-roots/` (ABR-69, B4). Each real host must apply those sources explicitly after review; the README paths must not be assumed installed on every machine.

Future resolvers should return full source-attributed README content for requested documents, fail visibly when required dependencies are unavailable, and never treat README text or research profiles as executable authority. Onboarding a new host must not commit native CLI sessions, credentials, or private state.

## Memory and integration owners (ABR-70)

The context manifest also maps the Git-owned memory and integration READMEs: `repo.memory`, `repo.memory.migrations`, `repo.memory.scripts`, `repo.integrations`, `repo.integrations.litellm`, and `repo.integrations.openrouter`. These document active implementation boundaries but are not runtime instructions or an installed resolver.

## Shared context template publication (ABR-71)

The reusable Git source set `../templates/context/` is published only through the reviewed `scripts/publish-context-templates.py` installer. After merge, run `--apply` explicitly on Ubuntu and verify `--check` against `/opt/agent-tools/templates/context/`. The managed snapshot includes `.managed-context.json` for version/hash provenance and is not a runtime configuration or an available `agent-context` command.

## Context metadata schemas (ABR-72)

This manifest and its README headers now follow the versioned `templates/context/context-manifest.schema.json` and `context-frontmatter.schema.json` contracts. The Git-owned `scripts/validate-context-contract.py` checks document ID uniqueness, declared dependencies/cycles, safe relative paths and platform-aware root override semantics. A named `AGENT_CONTEXT_*_ROOT` environment override takes priority over an optional platform default, then the declared root default; the path must be native absolute and validation does not create missing host directories. The [schema policy](../docs/blueprints/agent-context/CONTEXT_SCHEMA.md) documents portability and boundaries. The resolver itself remains a later milestone.

## Portable context CLI (ABR-73 / C2)

Use `python3 scripts/agent_context_cli.py validate` from the repository (or `--repo-root PATH validate` from another working directory) for the v1 manifest and 13 README source contracts. After review/merge, the guarded `scripts/install-agent-context.py --apply` installs a deterministic `/opt/agent-tools/bin/agent-context` zipapp on Ubuntu; verify with `--check` and then `agent-context --version`. The command runs with host Python dependencies and does not run or dispatch agents. `--topic`, `--path`, `--files-changed` and output formats arrive in C3.

## Update discipline

Update this README and its manifest together when document IDs, aliases, source paths, dependencies, or bootstrap semantics change. Update nearest owning READMEs in the same PR as behavioral, configuration, security, routing, or deployment changes. Context metadata does **not** authorize filesystem access, credential use, code execution, or deployments.
