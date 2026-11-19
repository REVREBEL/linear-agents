---
context:
  id: repo.jobs
  version: 1
  title: Job admission, dispatch and lifecycle
  topics: [jobs, admission, dispatch, lifecycle]
  requires: [repo.bridge]
  applies_to: ["jobs/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Job system

`admission/` validates and deduplicates deliveries. `dispatch/` contains provider-specific adapters. `preparation/` writes canonical task payloads. `lifecycle/` tracks process and progress. `persistence/` owns atomic durable ledger semantics. Previous flat `jobs/*.mjs` module paths are compatibility re-exports; use canonical imports in new code. The runtime `linear-jobs/` folder is not inside this source tree.
