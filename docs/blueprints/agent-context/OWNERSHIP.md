# Agent Context — source-of-truth and host-root ownership contract

Status: **implementation contract** for ABR-60 (A1). This document establishes responsibility boundaries; it does not change installed tools or enable any runtime configuration.

## Canonical sources and runtime state

| Root | Owner and purpose | Source of truth | Allowed changes |
| --- | --- | --- | --- |
| `<repo>/agents/` (Ubuntu: `/home/bridge/agent-bridge/agents/`) | Git-reviewed agent definitions, catalogs, executable agent packages and registry schemas | **Git**: `agents/registry.json` + `agents/registry.schema.json` are the executable **declarative** Registry v2 contract; the research catalog and candidate profiles are separately versioned | PRs with schema checks, profile validation and reviewed promotion |
| `<repo>/templates/context/` | Portable README, profile and context templates | **Git** | PRs; an installer may publish a managed copy to `/opt/agent-tools/templates/context/` |
| `<repo>/.agents/` (planned) | Project-local context bootstrap, tool-agnostic skill entrypoints and root alias manifest | **Git**, as established in milestone B | PRs; do not overwrite existing `.agents/skills/` |
| `/opt/agents/` | Native, identity-scoped agent runtime homes, local CLI configuration, sessions, authentication state and caches | **Host-owned private runtime state**; not mirrored to Git | Controlled local setup or runtime tools, with documented identities and permissions |
| `/opt/agent-tools/` | Shared **agent-specific** tooling: wrappers, skills/plugins, launch utilities and managed copies of context templates | Reviewed installer/source manifests in Git; host artifacts are installations, not independent master definitions | Reviewed tool installation/update; respect host access controls |
| `/opt/global-tools/` | Shared **general-purpose** development tooling for authorized Ubuntu users: Volta, Bun, uv, Cargo, Go, npm, PM2, etc. | The package/tool manager and reviewed provisioning configuration | General-purpose toolchain provisioning, independent of Bridge-specific agent identity |
| `<repo>/bridge/`, `jobs/`, `routing/`, `integrations/` | Executable admission, dispatch, routing, lifecycle and provider adapters | **Git implementation** plus validated operational configuration | PRs, tests and required deployment/activation procedures |

`<repo>` means the checked-out project root, **not** a hardcoded Ubuntu path. A different machine or repository can adopt the same arrangement with different host-root paths.

## Agent profile contracts are separate

1. **Research/candidate profiles:** `agents/agent-registry.yaml`, `agents/profiles/`, and the versioned research entry schema at `templates/context/agent-profile.entry.schema.json`. Their descriptive model, routing and security fields are **claims to verify**; they confer no dispatch authority.
2. **Executable Bridge registry:** `agents/registry.json` / `agents/registry.schema.json` (`schemaVersion: 2`). This is a declarative identity, Worker and runtime-contract registry. Admission, authorization and executable dispatch must still be enforced by Bridge implementation.
3. **Host-local runtime manifests and native CLI config:** `/opt/agents/registry/agent-runtimes.json` currently declares `schemaVersion: 1` and `status: staged-not-integrated`; it is **not a second executable source of truth**. OpenCode, Codex and other CLIs retain their own private native config under individual runtime homes.

The name `agent-registry-v2.yaml` refers to a **research snapshot**, not the executable `agents/registry.json` schema. Do not infer equivalent schema versions from filenames.

## Change and promotion boundaries

- **Research → executable:** Verify model, installed CLI flags, provider identity, endpoint, permissions, workspace authorization, Linear Worker and credential mapping, then review an explicit schema translation. Do not execute catalog `commandTemplate` strings directly.
- **Git → host:** Reviewed source and install scripts may deploy *approved artifacts* or configuration snapshots. Synchronization is **not automatic**; a merged PR alone does not change services or native runtime homes.
- **Host → Git:** Inspect relevant host state, sanitize it and propose an explicit Git change. Never automatically import runtime home trees, tokens, histories, sessions, cache files, private routing or credential values.
- **Executable versus profile:** A shared binary may live in `/opt/global-tools/` or an agent wrapper in `/opt/agent-tools/`, while agent-specific config/state lives in `/opt/agents/<identity>/`. Binary installation does not establish a Linear identity or permit dispatch.
- **Authorization:** Profile or README metadata documents behavior; only validated Bridge admission, runtime and operating-system controls authorize actions. Keep OAuth/application secrets in established protected credential stores, not in the Git profile or README.
- **No implicit fallback:** A locally pinned model/runtime must not silently switch to a remote provider if unavailable. Specify and test any allowed fallback per agent.
- **README policy:** Change the nearest owning README in the same PR when modifying behavior, contracts, dependencies, permissions, security or deployment procedures. Adding profile data without changing interpretation is not by itself a runtime-behavior change. Root bootstrap and CI enforcement are separate tasks (B2/D3).

## Existing Ubuntu staging notes (verification, not deployment)

- `/opt/agents/` presently holds runtime homes such as `opencode/`, `codex/`, `qwen/`, `gemini/`, `kilo/`, `trae/` and `memu/`.
- `/opt/agent-tools/` currently includes `bin/`, `agents/` and `systemd/`; `/opt/global-tools/` includes shared tool-manager directories.
- `/opt/agents/registry/agent-runtimes.json` remains a **disabled** host-local copy. ABR-63 defines its reviewed intended snapshot in `templates/context/agent-runtimes.staged.json` and a guarded host reconciliation command in `scripts/reconcile-agent-runtimes.py`. The historical host file retains stale values until reviewed source is explicitly applied. See [the verified inventory](RUNTIME_INVENTORY.md).
- Host-root `README.md` files and context frontmatter will be added in ABR-69; do not claim they exist before that task.

## Acceptance and follow-up

ABR-60 is satisfied when the source of truth, host responsibilities, update boundaries and review/promote rules above are documented and linked from the existing agent and blueprint READMEs. Subsequent milestones own executable changes: ABR-63 (staged host registry reconciliation), ABR-64 (profile promotion adapter), ABR-66–71 (bootstrap/host READMEs/templates), ABR-72–76 (context resolver), and ABR-80–89 (harness integrations and acceptance).

See [Agent Context blueprint](README.md), [implementation tasks](IMPLEMENTATION_TASKS.md), [profile mapping](../../../templates/context/profile-mapping.md), and [agent directory README](../../../agents/README.md).
