---
context:
  id: host.global-tools
  version: 1
  title: Ubuntu shared developer toolchains
  topics: [tooling, development, node, host]
  requires: []
  applies_to: ["**/*"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

<!-- Managed source: templates/context/host-roots/global-tools/README.md -->
# /opt/global-tools — shared general-purpose developer toolchains

## Owns
General-purpose development and language tool installations used by authorized Ubuntu users, independent of agent account identities. The tool manager and reviewed provisioning configuration determine installed versions and binaries.

## Does not own
Per-agent CLI configuration, sessions, caches and authentication (`/opt/agents/`); Bridge-specific wrappers, skills and managed agent-context templates (`/opt/agent-tools/`); or Git-reviewed agent and dispatch policies (`agents/`, `bridge/`, `jobs/`).

## Structure and dependencies
Observed top-level directories include `volta/`, `bun/`, `uv/`, `cargo/`, `go/`, `npm/`, `pm2/`, `yarn/`, `venv/`, and `snap/`. These are shared toolchain locations, not agent identities.

The reviewed staged CLI harness inventory uses `/opt/global-tools/volta` as its Node home and may reference shims such as `/opt/global-tools/volta/bin/codex`, `gemini`, and `kilo`. Existence of a binary is distinct from user authentication, adapter correctness, or Bridge launch permission.

No mandatory README context dependencies. Its context ID is `host.global-tools`; optional root override is `AGENT_CONTEXT_GLOBAL_TOOLS_ROOT`.

## Runtime contract
General tool installation and updates follow their respective package/tool manager policies. The Bridge must use the reviewed runtime executable and host authorization contract rather than treating the presence of a global binary as consent or evidence of dispatch readiness.

## Verification (read only)
- `ls -ld /opt/global-tools /opt/global-tools/volta`
- `ls -l /opt/global-tools/volta/bin`
- `/opt/global-tools/volta/bin/node --version` when the executable is installed

## Update policy
The reviewed source of **this README** is `templates/context/host-roots/global-tools/README.md` in Git. Reconcile via `scripts/reconcile-host-root-readmes.py --apply` after a reviewed source change. Do not commit private environment exports, host tokens or user-specific runtime data.
