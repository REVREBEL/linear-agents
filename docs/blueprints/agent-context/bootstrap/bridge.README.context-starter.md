---
context:
  id: repo.bridge
  version: 1
  title: Agent Bridge runtime
  topics: [bridge, dispatch, deployment, profiles]
  requires: [repo.agents, host.agent-runtimes, host.agent-tools, host.global-tools]
  applies_to: [bridge/**, jobs/dispatch/**, jobs/admission/**]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Bridge runtime — context starter

Merge the frontmatter and relevant dependency relationships into the **existing** `bridge/README.md`. Do not overwrite the existing implementation documentation.

## Responsibility
The bridge receives authenticated agent jobs, resolves approved workspace routing, dispatches a provider runtime, and retains lifecycle and callback ownership. Agent profile metadata describes intended behavior but does not authorize actions.

## Cross-directory contracts
- `agents/`: source-controlled research catalog, runtime registry and agent implementation packages
- `/opt/agents/`: native CLI profiles, sessions, caches, private runtime state
- `/opt/agent-tools/`: agent-specific shared executable wrappers, tools and skills
- `/opt/global-tools/`: shared general development tools

## Verification
Validate the registry; run focused bridge tests; check the installed CLI arguments, agent-specific process ownership and completed callback contract. Record the authoritative module paths and operational commands after examining the live checkout.
