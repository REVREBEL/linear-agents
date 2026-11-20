---
context:
  id: repo.application
  version: 1
  title: Next.js application architecture
  topics: [application, nextjs, typescript]
  requires: [host.design-system]
  applies_to: ["src/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Next.js application ownership

Owns the Next.js application code under `src/`, including page components
and the Payload CMS integration. API and collection changes have their own
nearest owner under `src/collections/`.
