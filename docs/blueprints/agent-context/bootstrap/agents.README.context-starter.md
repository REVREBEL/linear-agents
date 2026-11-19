---
context:
  id: repo.agents
  version: 1
  title: Agent definitions and runtime registry
  topics: [agents, profiles, registry, deployment]
  requires: [host.agent-runtimes, host.agent-tools, host.global-tools]
  applies_to: [agents/**]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Agent definitions — context starter

Merge this frontmatter into the existing `agents/README.md` rather than replacing its content.

**Two separate contracts:**

1. NotebookLM research profiles use `agent-registry-schema.json` and the `AgentRegistryEntry` shape (top-level fields: `id`, `displayName`, `description`, `kind`, `provider`, `model`, `runtime`, `linearBridge`, `taxonomy`, `routing`, `execution`, `permissions`, `security`). The catalogs `agent-registry-v2.yaml` and `agent-registry.yaml` contain these entries. No entry grants execution authority by itself.
2. The executable Worker identity and runtime registry uses `agents/registry.json` and `agents/registry.schema.json` with `schemaVersion: 2` and a **different** nested structure (`profile`, `runtimeContract`, `executionPolicy`, `worker`, `linear`). Promotion requires explicit field mapping and runtime validation.

Candidate imports and edits should update source profiles and relevant references but do not automatically trigger runtime deployment. A change to code reading, routing or executing profiles does require the owning README and tests to be updated.