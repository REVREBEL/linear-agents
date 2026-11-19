# Reusable agent-context templates

These files are source-controlled **templates**, not deployed agent configuration. The project-root `.agents/README.md` and `.agents/context.yaml` bootstrap metadata is now tracked in Git (ABR-66), but the shared resolver, host-root README rollout and harness integrations remain later milestones. The two agent-profile formats below are intentionally incompatible.

## Ownership

| File | Contract | Edit policy |
| --- | --- | --- |
| `agent-profile.entry.schema.json` | **Canonical research-entry JSON Schema** from the approved NotebookLM `AgentRegistryEntry` contract | Edit here, with reviewed schema change; synchronize `agents/agent-registry-schema.json` as a **compatibility mirror**, enforced by validation |
| `agent-profile.v2.template.yaml` | One example research entry (not an agent registered for dispatch) | Keep schema-valid; placeholders are not verified model/Worker settings |
| `agent-registry.catalog.template.yaml` | Catalog wrapper with `agents[]` entries, each validated against the research-entry schema | Wrapper `version: 1.0.0` is catalog metadata, not Bridge Registry v2 |
| `bridge-runtime-registry.v2-entry.template.json` | One *executable-registry entry example*, distinct from the research entry | Validate against `agents/registry.schema.json#/$defs/agent`; do not use research schema |
| `profile-mapping.md` | Research-to-runtime translation review requirements | Document verified mappings; no automatic promotion |
| `research-promotion.review.template.json` | Deliberately incomplete approval, evidence and Bridge-only mapping record | Fill with real reviewed provenance; compile using `scripts/review-research-promotion.py`, producing an inert proposal only |
| `agent-runtimes.staged.json` | **Reviewed desired host-only CLI harness snapshot**, independent of all agent-profile and Worker registries | Source for the opt-in reconciliation command `scripts/reconcile-agent-runtimes.py`; all dispatch flags must remain false |
| `README.template.md`, `host-root.README.template.md`, `context-frontmatter.schema.json` | Proposed portable README context contract | Context frontmatter `version: 1` is independent of either agent schema version |

The compatibility mirror at `agents/agent-registry-schema.json` exists because `agents/agent-registry.yaml` references a co-located research schema. It is **not** a third schema to edit independently. Update both copies in the same reviewed change until an explicit migration removes the legacy mirror. The validation script rejects mismatches and duplicate copies under blueprint `references/`.

## Research entry versioning (ABR-65)

The attached `AgentRegistryEntry` research schema has **no** `profileVersion`. Current validation and the research-promotion proposal compiler reject an injected field even though the original JSON Schema permits additional properties. Adding per-entry versioning requires an explicit schema/mirror migration, compatible catalog/candidate updates and revised negative tests. See [the version policy](../../docs/blueprints/agent-context/PROFILE_VERSION_POLICY.md). Catalog `version: 1.0.0`, executable Registry `schemaVersion: 2` and README `context.version: 1` are unrelated.

## Research catalog source

`agents/agent-registry.yaml` is the current, canonical **15-profile research catalog**. Each entry is also in `agents/profiles/candidates/<id>.yaml`; the current catalog and candidates must match **each other**. At ABR-62 adoption they also match the approved 15-agent snapshot at `docs/blueprints/agent-context/references/agent-registry-v2.yaml`. That snapshot and the earlier 14-entry snapshot are immutable history; future reviewed catalog revisions may advance independently. Neither file indicates that a provider, model, Colab endpoint or Worker is installed or reachable.

## Why research and execution schemas are different

Research profiles contain model claims, taxonomy, candidate routing, illustrative commands, and intended permissions. They do not establish executable packages, deployed Workers, OAuth identities, or permitted runtime actions.

The live Bridge registry is a separate **declarative** contract with `schemaVersion: 2`, `worker`, `linear`, `runtimeContract`, and `executionPolicy`. Runtime enforcement belongs to reviewed Bridge code and deployment validation. Neither JSON schema may be treated as a fallback for validation under the other.

See [Agent registry ownership](../../agents/README.md), [field mapping](profile-mapping.md), and [Agent Context ownership](../../docs/blueprints/agent-context/OWNERSHIP.md).

## Verification

GitHub Actions runs `scripts/validate-context-blueprint.py` for changes to these templates or the blueprint. It checks canonical/mirror byte parity, research examples against the research schema, the runtime entry against its independent schema, and intentional cross-schema rejection. No executable runtime is activated by running these checks.
