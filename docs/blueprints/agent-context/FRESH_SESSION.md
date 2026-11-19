# ABR-86 (E2) — One-command fresh-session context acceptance

**Contract:** A newly started coding/review agent can invoke the **existing shared Agent Context resolver once** to retrieve all Git/host-root documentation for the job lifecycle. No new resolver, per-harness configuration, job-dispatch permission, session cache, or token is required.

## One command

From any working directory, with the reviewed project checkout available:

`python3 /path/to/linear-agents/scripts/agent_context_cli.py --repo-root /path/to/linear-agents --topic jobs --format json`

When run from the repository root, the shorter form is `python3 scripts/agent_context_cli.py --topic jobs --format json`. The equivalent reviewed installed CLI, when present, is `agent-context --repo-root /path/to/linear-agents --topic jobs --format json`.

The existing `repo.jobs` README owns the `jobs` topic and **requires `repo.bridge`**. `repo.bridge` in turn requires `repo.agents` and the three independently rooted host documents. This is an ordinary transitive README dependency graph: no new bootstrap special-case or duplicated owner list is added.

| Order | Context ID | README location |
| --- | --- | --- |
| 1 | `host.global-tools` | `/opt/global-tools/README.md` (or configured host-root override) |
| 2 | `host.agent-tools` | `/opt/agent-tools/README.md` (or override) |
| 3 | `host.agent-runtimes` | `/opt/agents/README.md` (or override) |
| 4 | `repo.agents` | `agents/README.md` |
| 5 | `repo.bridge` | `bridge/README.md` |
| 6 | `repo.jobs` | `jobs/README.md` |

A **complete** response must include these six IDs in dependency-first order, full untouched README bodies, original `sourcePath`, `gitSourcePath`, source revision SHA, content SHA-256, and inclusion reasons. `contextVersion`, `gitHeadSha`, selection metadata, `unmatchedPaths` and `missingDocuments` must remain visible. Successful strict retrieval reports `partial: false`, `missingDocuments: []`, and `unmatchedPaths: []`.

## Live Ubuntu validation (November 19, 2026)

At merged E1 baseline commit `5ad4a53`, a fresh Python CLI process launched from `/tmp` with explicit `--repo-root` returned **all six IDs**, `partial: false`, and no missing documents. This run read the actual installed `/opt/agents/README.md`, `/opt/agent-tools/README.md`, `/opt/global-tools/README.md`, plus the three Git-root READMEs. The returned source paths and hashes were present. No agent or service was launched, and nothing was written to the host-root directories.

## Repeatable acceptance tests

`python3 scripts/test_context_fresh_session.py` starts a **new Python interpreter** from an unrelated working directory for each CLI request, with disposable host roots populated from immutable Git-reviewed README bytes. It proves:

- One invocation using `--topic jobs` includes exactly the six sources, dependency-first, with full original content, pinned Git SHA, per-source hashes, reasons and no duplication.
- Repeated fresh processes return byte-identical JSON, even when the invocation happens from a different working directory or an inherited `AGENT_CONTEXT_REPO_ROOT` points elsewhere (explicit `--repo-root` wins).
- The `lifecycle` topic selects the same complete graph.
- If a selected host README is missing, the ordinary command **fails closed**; only explicit `--allow-partial` returns incomplete output and identifies the missing source with its inclusion reasons.
- A full D5 handoff of the same six sources is verifiable by a **separate receiver process** against the pinned Git checkout after the disposable host-root README files are removed.

Native Ubuntu, macOS and Windows CI run the test with pinned Python dependencies. The installed host-root paths are Linux-only default locations; tests use platform-native absolute root overrides. The live Ubuntu check establishes host-readiness separately from fixture-based portability checks.

**Boundaries:** This is a one-command *context retrieval* acceptance test. It does not claim Qwen Local was dispatched, that a fresh model conversation ran, that private `/opt/agents` profiles were read, or that credentials/memory were accessed. A new agent session can invoke the command without prior process state. Live Qwen Local execution and authenticated Linear canary remain ABR-58; memory scoping remains E3. No production deployment, PostgreSQL UI, OAuth or service restart is part of E2.
