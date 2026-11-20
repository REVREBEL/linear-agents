# Reusable agent-context templates

These files are source-controlled **templates**, not deployed agent configuration. The project-root `.agents/README.md` and `.agents/context.yaml` bootstrap metadata is tracked in Git (ABR-66), and ABR-71 provides an **explicit versioned publisher** for managed copies under `/opt/agent-tools/templates/context/`. The shared resolver and harness integrations remain later milestones. The two agent-profile formats below are intentionally incompatible.

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
| `README.template.md`, `host-root.README.template.md`, `context-frontmatter.schema.json`, `context-manifest.schema.json` | Reviewed v1 README frontmatter and root/document alias contracts (ABR-72) | Validate with `scripts/validate-context-contract.py`; `context.version` and `contextVersion` are independent of executable agent schemas |
| `host-roots/{agents,agent-tools,global-tools}/README.md` | Reviewed, non-secret Ubuntu host-root README **sources** (ABR-69) | Install explicitly via `scripts/reconcile-host-root-readmes.py` after review; no automatic host sync |

The compatibility mirror at `agents/agent-registry-schema.json` exists because `agents/agent-registry.yaml` references a co-located research schema. It is **not** a third schema to edit independently. Update both copies in the same reviewed change until an explicit migration removes the legacy mirror. The validation script rejects mismatches and duplicate copies under blueprint `references/`.

## Versioned template publication (ABR-71)

The canonical source remains **this Git folder**, including the reviewed host-root README sources. From the merged Agent Bridge checkout on Ubuntu, run `python3 scripts/publish-context-templates.py --validate` to validate tracked sources, `--check` to compare the installed managed directory without writes, and `--apply` to install after review. The publisher copies the tracked `.md`, `.yaml`, and `.json` files under `/opt/agent-tools/templates/context/`, preserving relative paths, plus a deterministic `.managed-context.json` with schema version, latest source-tree Git commit, per-file SHA-256/size and a tree digest. It never copies untracked runtime data.

`--apply` is **explicit and idempotent**. The first run creates the missing destination; later runs do nothing when hashes match. A reviewed source change installs a complete new directory snapshot and retains the previous managed snapshot in a sibling `context.backup-*` directory. Unknown files, edited managed files, symlink escapes and unmanaged installation roots cause a refusal instead of an overwrite. This installation is **documentation/templates only**, not an executable context resolver, runtime configuration sync, credential migration, or agent dispatch action. Reusable templates under this path never replace native profiles under `/opt/agents/`.

## Agent Context v1 contract (ABR-72)

The canonical `.agents/context.yaml` manifest is validated against `context-manifest.schema.json`. The shared `context-frontmatter.schema.json` defines the seven required README metadata fields. A reusable validator checks duplicate YAML keys, root aliases, safe relative paths, cross-document IDs, dependencies and cycles; optional platform overrides select a native absolute path without requiring an installed resolver. See [the context schema contract](../../docs/blueprints/agent-context/CONTEXT_SCHEMA.md). The publisher includes both v1 schema files in the required managed template set.

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


## E4 portable reviewed host sources in unrelated coding repositories (ABR-88)

A second repository can use the same Context v1 schemas, CLI modules and [independent Next.js example](../../docs/blueprints/agent-context/examples/README.md) without adopting any Agent Bridge folder names or worker registrations. For a non-repo document, `.agents/context.yaml` may declare `source: templates/context/host-roots/<custom>/README.md` as the **Git-reviewed** README source; its declared root and `path: README.md` still describe the optional real host location. The resolver checks exact host bytes against the pinned Git source and applies the normal strict/partial policy. Existing special Bridge alias IDs retain their fixed Git source and location; a conflicting `source` is rejected. The optional `source` is **not allowed on repository-owned entries** (which already reference their Git-owned `path`); the manifest schema description and runtime validator both make that restriction explicit. The three legacy host IDs may restate only their identical, fixed reviewed sources, never substitute another path. The optional source is not a network URL, install instruction or execution grant. Run `python3 scripts/test_context_second_repo.py` for the independent Git/Next.js acceptance.
