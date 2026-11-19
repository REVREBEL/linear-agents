# Research agent catalog inventory and reconciliation (ABR-62 / A3)

Status: **approved research source-of-truth decision**. This is a file and schema reconciliation, not a claim of provider availability, CLI compatibility, deployed Worker identity or dispatch readiness.

## Inventory

| Location | Contents | Role |
| --- | --- | --- |
| `agents/agent-registry.yaml` | **15** research profiles; catalog `version: 1.0.0`, `lastUpdated: 2026-11-12T14:58:00-08:00` | **Canonical current research catalog**; review changes in Git |
| `agents/agent-registry-schema.json` | `AgentRegistryEntry` schema | Existing co-located compatibility mirror of `templates/context/agent-profile.entry.schema.json`; validator enforces byte equality |
| `agents/profiles/candidates/*.yaml` | **15** individual candidate profiles, one per catalog ID | Human-readable individual research records, each semantically equal to its current catalog entry |
| `agents/profiles/research/README.md` | Research evidence and promotion rules | Instructions and ownership; not a second catalog |
| `docs/blueprints/agent-context/references/agent-registry.yaml` | **14** profiles; `lastUpdated: 2026-11-12T13:10:00-08:00` | Immutable pre-Colab research snapshot |
| `docs/blueprints/agent-context/references/agent-registry-v2.yaml` | **15** profiles; `lastUpdated: 2026-11-12T14:58:00-08:00` | Immutable approved newer research snapshot; **v2 in filename is not a schema version** |
| `agents/registry.json` + `agents/registry.schema.json` | Separate `schemaVersion: 2` executable identity catalog | Declarative Bridge Worker/runtime contract, **not** a research catalog |
| `/opt/agents/registry/agent-runtimes.json` | Host-local `schemaVersion: 1`, `staged-not-integrated` | Nonauthoritative runtime discovery snapshot; reconciliation belongs to ABR-63 |

Host-only, untracked `agents/profiles/research/*.yaml` files were present in the inspected Ubuntu checkout when A3 began. They are not included in the Git canonical inventory and must not be overwritten or automatically imported during reconciliation.

## Approved 15 research IDs

`beam`, `codegeex4`, `codellama`, `codestral-fim`, `colab-notebook-agent`, `crouton-alpha`, `ernie-5-5-flash`, `flint`, `gemma-4-31b`, `inkling-2-small`, `liquid-lfm3`, `mistral-moderation`, `nemotron-rerank-vl`, `north-mini-code`, `parallel-decisions-fast`.

The newer approved snapshot adds exactly one ID, **`colab-notebook-agent`**. The 14 previously cataloged agent entries compare equal after YAML parsing. The earlier and newer catalogs both report `version: 1.0.0`; the only shared wrapper changes are the timestamp and `totalAgents` count (14 → 15). All reported CLI commands, model IDs, endpoints, quotas and ratings remain *unverified research assertions* unless independently tested.

## Source-of-truth decision

1. Maintain only **`agents/agent-registry.yaml`** as the active, current research catalog. This update adds the Colab entry from the approved 15-agent snapshot without rewriting the other 14 entries.
2. Maintain an individual YAML file in **`agents/profiles/candidates/<id>.yaml`** for every catalog entry; both representations must be semantically identical. Preserve the existing 14 individual files and add `colab-notebook-agent.yaml`.
3. Preserve both historical attached snapshots unchanged under `docs/blueprints/agent-context/references/`; do not make the `v2`-named snapshot a second active catalog.
4. Keep the existing research `AgentRegistryEntry` schema independent of the executable `agents/registry.schema.json` contract. Keep the compatibility schema mirror byte-identical until an explicit migration.
5. Validate catalog IDs, unique entries, counts, historical 14-entry parity, latest approved snapshot parity and candidate file parity before merging later catalog changes. A future research update must first update the approved snapshot baseline by an explicit reviewed decision rather than bypassing the consistency check.

## Dispatch and tooling boundary

Adding `colab-notebook-agent` to the research catalog does **not** add a Worker, OAuth identity, active provider, Colab deployment, Ollama configuration, Bridge runtime entry or permission to execute. Promotion and verified field mapping are tracked separately in **ABR-64**. The host runtime snapshot is reconciled separately under **ABR-63**.

See [the ownership contract](OWNERSHIP.md), [research-to-runtime mapping](../../../templates/context/profile-mapping.md), and [the candidate folder README](../../../agents/profiles/candidates/README.md).
