# Deterministic compilation and artifact work orders

Use for generated registries, routers, indexes, dependency projections, package manifests, lockfiles, and reproducible build outputs.

1. Identify authoritative inputs, versions, schema, output paths and whether generation is read-only, staging-only, or authorized to update canonical outputs.
2. Prefer the existing compiler/generator; never execute a historical writer against the current library without contract verification.
3. Validate all required inputs and expected output coverage. If artifacts contain links, dependency closure or a catalog router, check their references; if resource manifests, verify content digests.
4. When deterministic output is required, run twice on the same snapshot and compare normalized byte outputs (excluding explicitly volatile metadata), record the hashes and mismatch diff.
5. **PASS** requires schema adherence, reconciliation to scoped input population, required integrity/reference checks and repeatability, plus the issue's unique assertions.
6. Publication is **not** implied by successful generation. Review staging diff before any canonical change.
