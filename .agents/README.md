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

This directory owns the **project-local context entrypoint**, not agent execution or authorization. Start with the existing root [`AGENTS.md`](../AGENTS.md) for operational guardrails; use [`context.yaml`](context.yaml) as the planned document/root alias map. The context resolver is not installed yet: the manifest is inert metadata until Milestones C and D deliver the CLI and harness integrations.

## Ownership

- `context.yaml` declares `contextVersion: 1`, logical document IDs, optional host-root aliases, and future entrypoints. Its relative repository paths are resolved from the **project root** (parent directory of `.agents/`), never an arbitrary command working directory.
- The existing [`skills/`](skills/) directory remains independently owned. Adding context documentation does not replace, remove, or activate any skill. The proposed `agent-context` skill is [staged in the blueprint](../docs/blueprints/agent-context/bootstrap/.agents/skills/agent-context/SKILL.md) for Milestone D1.
- [`../templates/context/`](../templates/context/) holds portable README/context templates under Git review. [`../docs/blueprints/agent-context/`](../docs/blueprints/agent-context/) records the implementation plan and source-of-truth boundaries.

## Document readiness

The `repo.bootstrap`, `repo.agents`, `repo.bridge`, and `repo.jobs` document paths currently exist in Git. The owning `agents/` and `bridge/` READMEs now declare their `context` frontmatter under ABR-68 (B3), including references to optional host roots. The three optional host-root README paths are **future documents** owned by ABR-69 (B4) and must not be assumed available on every machine.

Future resolvers should return full source-attributed README content for requested documents, fail visibly when required dependencies are unavailable, and never treat README text or research profiles as executable authority. Onboarding a new host must not commit native CLI sessions, credentials, or private state.

## Update discipline

Update this README and its manifest together when document IDs, aliases, source paths, dependencies, or bootstrap semantics change. Update nearest owning READMEs in the same PR as behavioral, configuration, security, routing, or deployment changes. Context metadata does **not** authorize filesystem access, credential use, code execution, or deployments.
