# Reviewed Ubuntu host-root context READMEs

**Source of truth:** these three Git-reviewed documents, not private runtime directories. Each file has a stable `context.id` that matches the optional host-root aliases declared by `.agents/context.yaml`.

| Git source | Installed target | Context ID |
| --- | --- | --- |
| `agents/README.md` | `/opt/agents/README.md` | `host.agent-runtimes` |
| `agent-tools/README.md` | `/opt/agent-tools/README.md` | `host.agent-tools` |
| `global-tools/README.md` | `/opt/global-tools/README.md` | `host.global-tools` |

## Reconciliation

From a reviewed Agent Bridge Git checkout on the target Ubuntu host:

- `python3 scripts/reconcile-host-root-readmes.py --validate` verifies all source documents against the frontmatter schema and manifest aliases without touching the host.
- `python3 scripts/reconcile-host-root-readmes.py --check` compares those sources with installed documents, reporting missing or drifted READMEs.
- `python3 scripts/reconcile-host-root-readmes.py --apply` explicitly installs the reviewed three documents with existing host-directory write permissions, retaining backups when managed files change.

The installer requires existing `/opt/agents`, `/opt/agent-tools` and `/opt/global-tools` directories; does not create or change runtime homes; refuses symlinks and unowned READMEs; and changes **only** the three named README files. An initial check is expected to report missing files until the reviewed source has been applied after merge.

These documents contain ownership, discovery, dependencies and read-only verification instructions; no secrets, account state or private conversations. They do not enable a context resolver, Linear agent, Worker, adapter, shell launcher or service.

The general context template remains `templates/context/host-root.README.template.md`. Milestone B6 separately owns installation of shared reusable templates into `/opt/agent-tools/templates/context/`.
