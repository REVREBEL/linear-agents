---
context:
  id: host.agent-tools
  version: 1
  title: Ubuntu shared agent-specific tools
  topics: [agents, tooling, wrappers, host]
  requires: [host.global-tools]
  applies_to: ["**/*"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

<!-- Managed source: templates/context/host-roots/agent-tools/README.md -->
# /opt/agent-tools — shared agent-specific tooling

## Owns
Shared agent launcher wrappers, agent-specific utilities, managed skills and approved context templates installed for multiple native identities. This is an **installation root**, not the authoritative source for source-controlled Bridge code or research profiles.

## Does not own
Agent account authentication, private native sessions, model caches or per-identity configuration (those belong to `/opt/agents/`). General-purpose tools and language runtimes belong to `/opt/global-tools/`. Bridge dispatch, Worker identities, permissions and review rules remain in Git and its validated operational configuration.

## Structure and dependencies
Observed directories include `bin/`, `agents/`, and `systemd/`. Existing executable wrappers under `bin/` include `agent-exec`, `opencode`, `uv`, and `uvx` (observed files do not establish that the wrappers are healthy). ABR-73 adds the reviewed, explicitly installed `bin/agent-context` Python zipapp for v1 metadata validation. ABR-74 upgrades the same CLI to source-linked README retrieval by topic, path and changed files, with full Markdown/JSON and explanation output. ABR-75 adds fail-closed filesystem validation, including required roots, symlink protection and explicit partial reporting for missing optional host documentation. Harness integration remains a separate milestone. The reviewed ABR-71 publisher installs versioned, inert Git context template copies under `templates/context/` when explicitly applied after merge. Its `.managed-context.json` records file hashes and source revision; the publisher does not install a resolver or agent runner.

Depends on `host.global-tools` for shared language runtimes and tooling. Its context ID is `host.agent-tools`; the manifest's optional override is `AGENT_CONTEXT_AGENT_TOOLS_ROOT`.

## Runtime contract
Only reviewed scripts may install or update managed shared tools. A wrapper must not infer executable authority from a research profile, CLI directory or this README. The Bridge's separate runtime adapters and authorization checks govern invocation. Shared wrapper installation does not enable a Worker or session.

## Verification (read only)
- `ls -ld /opt/agent-tools /opt/agent-tools/bin`
- `ls -l /opt/agent-tools/bin`
- `test -x /opt/agent-tools/bin/agent-exec` (path/executable flag only; not an end-to-end launcher test)
- `python3 scripts/install-agent-context.py --check` from the merged Git checkout (read-only CLI artifact integrity)
- `/opt/agent-tools/bin/agent-context --version` after explicit installation; use `--repo-root PATH validate` for metadata checks, and `--repo-root PATH --topic profiles --format json` for strict source-linked README retrieval (C4: `--allow-partial` is an explicit opt-in for missing optional host READMEs only)
- `python3 scripts/publish-context-templates.py --check` from the reviewed Git checkout (read-only managed template comparison)

## Update policy
The reviewed source of **this README** is `templates/context/host-roots/agent-tools/README.md` in Git. Install source changes deliberately using `scripts/reconcile-host-root-readmes.py --apply`. Keep operational guidance synchronized with reviewed wrapper changes; do not copy credentials, private sessions, or host environment values into this document.
