---
context:
  id: repo.agents
  version: 1
  title: Agent definitions and runtime registry
  topics: [agents, profiles, registry, deployment]
  requires: [host.agent-runtimes, host.agent-tools, host.global-tools]
  applies_to: ["agents/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# Agent registry

This repository's `agents/` directory contains **source-controlled agent definitions and project registry files** used by Agent Bridge. It is **not** an empty placeholder and is **not** a mirror of the server's live `/opt/agents/` directory.

## Cross-root ownership contract (ABR-60)

The authoritative boundaries between Git definitions, native agent runtime homes, shared agent-specific tools and general Ubuntu toolchains are documented in [the Agent Context ownership contract](../docs/blueprints/agent-context/OWNERSHIP.md). Follow that contract before changing profile execution semantics, host setup, tool installation or dispatch.

## Independent profile contracts (ABR-61)

| Contract | Shape and authority | Validation |
| --- | --- | --- |
| **NotebookLM research profile** | Each `AgentRegistryEntry` is an *individual* candidate. Source-of-truth schema: [`templates/context/agent-profile.entry.schema.json`](../templates/context/agent-profile.entry.schema.json). The co-located `agents/agent-registry-schema.json` is a compatibility mirror for existing research tools and must remain byte-identical. | Research profile / each catalog `agents[]` item only. The catalog wrapper's `version: 1.0.0` is **not** a profile schema version. |
| **Bridge executable Registry v2** | `agents/registry.json` (`schemaVersion: 2`) and `agents/registry.schema.json`. Contains executable identities and declarative `worker`, `linear`, `profile`, `runtimeContract`, and `executionPolicy` metadata. | Validate the **full registry document** against `agents/registry.schema.json`; executable policy is enforced independently by running Bridge code. |

**Current research source of truth:** `agents/agent-registry.yaml` (15 candidate entries, including `colab-notebook-agent`). The earlier 14-profile research catalog and the approved 15-profile snapshot remain immutable references under `docs/blueprints/agent-context/references/`; `agents/profiles/candidates/` contains the same 15 researched entries as individual files. CI validates the current catalog against all individual candidate files and independently checks historical snapshot integrity. Future reviewed research updates may advance the canonical catalog without rewriting the snapshots. These are research records, not installed agents.

The research `runtime.commandTemplate` is an untrusted proposal, **not executable argv**. `kind`, transport, host, event, autonomy, memory and credential values differ between the contracts. Do not copy research profile entries directly into `registry.json`, infer deployment availability from research values, or let profile metadata grant privileges. Use the [review-gated mapping](../templates/context/profile-mapping.md) and verify every Bridge-only identity, path and Worker binding before promoting.

The version-like filename `agent-registry-v2.yaml` is a *research snapshot name*, distinct from the active executable `schemaVersion: 2`. The [context template README](../templates/context/README.md) explains the two examples and mirror policy.

## Research profile version gate (ABR-65)

The approved `AgentRegistryEntry` does not define per-entry `profileVersion`. The blueprint validator and promotion-proposal compiler reject silent additions until a separately reviewed schema migration explicitly defines version semantics, compatibility and tests. Catalog `version: 1.0.0` remains catalog metadata, not an agent schema version. See [the version migration policy](../docs/blueprints/agent-context/PROFILE_VERSION_POLICY.md).

## Ubuntu runtime boundary

- `/opt/agents/` is the canonical host location for runtime CLI profiles.
- Authentication, session databases, conversation history, installed binaries, memory, and runtime caches stay on Ubuntu, outside Git.
- Linux home-directory symlinks to live profiles, if required, are managed on the host.
- Agent definitions here may be versioned and reviewed independently of that private runtime state.

Do not copy a live `/opt/agents/` tree into this repository.

## Directory ownership (ABR-28)

| Location | Purpose | Dispatch authority |
| --- | --- | --- |
| `registry.json` + `registry.schema.json` | Canonical v2 machine-readable worker identity and execution contract | Declarative only; runtime enforces policy |
| `agent-registry.yaml` + `agent-registry-schema.json` | NotebookLM/research catalog of candidate models | **Not** the dispatch registry |
| `profiles/candidates/` | Standalone researched YAML profiles awaiting normalization and verification | None |
| `profiles/research/` | Research workflow, provenance, and promotion rules | None |
| `coding/<agent>/` | Implemented coding-agent packages and worker sources | Only through validated bridge dispatch |
| `bridge/<agent>/` | Bridge-owned agents, including event intelligence and reviewer | Only through validated bridge dispatch |
| Provider directories (`nvidia/`, `parallel/`, etc.) | Provider-specific JSON research snapshots | None |

The [ABR-64 proposal compiler](../docs/blueprints/agent-context/PROMOTION.md) checks provenance, explicit approval metadata, Worker source configuration and non-escalating policy before emitting a separately reviewable Registry v2 proposal. The compiler **does not** install or activate an agent.

Do not promote research profiles into `registry.json` without verifying model IDs, endpoints, provider availability, runtime executable, host permissions, and test results. A profile's presence never means that its CLI is installed or the agent is online. Do not relocate worker directories without separately updating package workspaces, registry paths, Wrangler configuration, and tests.

Research adapters should live in `integrations/<provider>/` once reviewed; job lifecycle and dispatch state belong in `jobs/`, not in the model profile catalog. The bridge's live routing still uses the existing runtime contract; the experimental `routing/environment-router.ts` is not a production switch.
