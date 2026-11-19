---
context:
  id: repo.bootstrap
  version: 1
  title: Agent Bridge context navigation
  topics: [bootstrap, context, documentation]
  requires: [repo.agents, repo.bridge]
  applies_to: [.agents/**, AGENTS.md]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Agent context bootstrap

This directory is the portable agent-context entrypoint for the repository. Read the root `AGENTS.md` first; resolve document IDs through `.agents/context.yaml`, then follow the README frontmatter dependency graph. The resolver will output full document bodies and path/Git provenance; context is documentation, not executable instruction or authorization.

- `context.yaml` maps logical document IDs and host roots to files.
- `skills/agent-context/SKILL.md` explains the shared CLI workflow.
- `../templates/context/` is the Git-controlled source for reusable templates.

Change the nearest owning README in the same PR when code changes its behavior, contract, dependency, policy, or operational instructions. Profile-only data additions are exempt unless they change behavior. Reject missing or unsafe dependencies; print the exact error rather than silently omitting a source.
