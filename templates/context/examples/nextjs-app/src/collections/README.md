---
context:
  id: repo.collections
  version: 1
  title: Payload collections and content contracts
  topics: [collections, payload, cms]
  requires: [repo.application]
  applies_to: ["src/collections/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Payload collection ownership

Owns schema and access-control changes under `src/collections/`. Inspect
the actual collection types and validation code before changing contracts.
