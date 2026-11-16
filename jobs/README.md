# Job system

`admission/` validates and deduplicates deliveries. `dispatch/` contains provider-specific adapters. `preparation/` writes canonical task payloads. `lifecycle/` tracks process and progress. `persistence/` owns atomic durable ledger semantics. Previous flat `jobs/*.mjs` module paths are compatibility re-exports; use canonical imports in new code. The runtime `linear-jobs/` folder is not inside this source tree.
