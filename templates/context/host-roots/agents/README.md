---
context:
  id: host.agent-runtimes
  version: 1
  title: Ubuntu native agent runtime homes
  topics: [agents, runtime, profiles, host]
  requires: [host.agent-tools, host.global-tools]
  applies_to: ["**/*"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

<!-- Managed source: templates/context/host-roots/agents/README.md -->
# /opt/agents — private native agent runtime homes

## Owns
Identity-specific native CLI configuration, authentication state, sessions, caches, and runtime-specific local data. These are **host-owned private state**, not source-controlled agent definitions. This README is public operational metadata and must not include credentials, session transcripts, model secrets, or private project routes.

## Does not own
Git-reviewed agent catalog, executable Bridge Registry v2, dispatch authorization or Worker identities. Those live in the Agent Bridge repository under `agents/`, `bridge/`, `jobs/`, and `routing/`. General-purpose tool binaries belong to `/opt/global-tools/`; shared agent-specific launcher wrappers belong to `/opt/agent-tools/`.

## Structure and dependencies
Observed native homes include `codex/`, `gemini/`, `kilo/`, `memu/`, `minstral/`, `openchamber/`, `opencode/`, `qwen/`, `trae/` and `.claude/`. Presence of a directory **does not prove a runnable CLI, authenticated account, supported adapter, or model availability**.

`registry/agent-runtimes.json` is a **staged, non-dispatching CLI harness inventory** (`schemaVersion: 1`, `status: staged-not-integrated`). Its reviewed desired source is `templates/context/agent-runtimes.staged.json` in Git. It is not an alternative to `agents/registry.json` and must not grant execution permissions.

Dependencies: `host.agent-tools` for launcher tooling; `host.global-tools` for shared developer runtimes. Cross-root alias `host.agent-runtimes` is declared in the project's `.agents/context.yaml`, with an optional host-root override `AGENT_CONTEXT_AGENTS_ROOT`.

## Runtime contract
Native profiles stay private and independently managed. The Bridge may only execute through its reviewed admission, routing, identity, and runtime adapters; installing a profile or adding a README never enables dispatch. Keep filesystem permissions and identity ownership under local administrator control.

## Verification (read only)
- `ls -ld /opt/agents /opt/agents/registry`
- `python3 scripts/reconcile-agent-runtimes.py --check` from the reviewed Git checkout (compares staged metadata, not CLI readiness)
- `python3 scripts/reconcile-agent-runtimes.py --probe` from the reviewed Git checkout (checks path existence, not login or dispatch)

## Update policy
The reviewed source of **this README** is `templates/context/host-roots/agents/README.md` in Git. Changes to the host's ownership/usage contract require a reviewed source change, then deliberate installation via `scripts/reconcile-host-root-readmes.py --apply`. Do not export private contents from this directory into Git documentation.
