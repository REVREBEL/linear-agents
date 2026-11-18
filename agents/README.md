# Agent registry

This repository's `agents/` directory contains **source-controlled agent definitions and project registry files** used by Agent Bridge. It is **not** an empty placeholder and is **not** a mirror of the server's live `/opt/agents/` directory.

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

Do not promote research profiles into `registry.json` without verifying model IDs, endpoints, provider availability, runtime executable, host permissions, and test results. A profile's presence never means that its CLI is installed or the agent is online. Do not relocate worker directories without separately updating package workspaces, registry paths, Wrangler configuration, and tests.

Research adapters should live in `integrations/<provider>/` once reviewed; job lifecycle and dispatch state belong in `jobs/`, not in the model profile catalog. The bridge's live routing still uses the existing runtime contract; the experimental `routing/environment-router.ts` is not a production switch.
