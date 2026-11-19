# Agent Context System — implementation tasks (corrected against uploaded profiles)

PostgreSQL configuration UI is intentionally out of scope. Work is staged so each milestone can be reviewed independently.

## Milestone A — Source-of-truth and profile separation

- [ ] A1. Establish a written ownership contract for Git `agents/` definitions, `/opt/agents/` private native runtime state, `/opt/agent-tools/` shared agent tools, and `/opt/global-tools/` general developer tools.
- [ ] A2. Preserve the attached `AgentRegistryEntry` research profile format (per-entry JSON Schema) independently of Bridge runtime Registry v2; document these as different contracts.
- [ ] A3. Inventory current profile and catalog files; record that the uploaded `agent-registry-v2.yaml` includes 15 profiles and older `agent-registry.yaml` includes 14 (`colab-notebook-agent` is newly present). Decide which catalog is the research source of truth.
- [ ] A4. Check and reconcile `/opt/agents/registry/agent-runtimes.json` (`schemaVersion: 1`, staged-not-integrated). Any snapshot generation must derive from an explicit source, never become a competing master registry.
- [ ] A5. Create a tested research-profile → executable-registry **promotion adapter**, with explicit mapping, provenance and approval. Reject unrecognized enums, unsafe CLI command templates, unverified endpoints, or missing Worker identities.
- [ ] A6. Ensure `profileVersion`, if adopted later, is introduced through a separate reviewed schema change, not silently added to the attached format.

## Milestone B — Project bootstrap and local documentation

- [ ] B1. Add `.agents/README.md` and `.agents/context.yaml` at the Agent Bridge Git root, preserving existing `.agents/skills/` entries.
- [ ] B2. Add brief context-bootstrap instructions in root `AGENTS.md`, teaching the agent to invoke the resolver before modifying code.
- [ ] B3. Add frontmatter to **existing** `agents/README.md` and `bridge/README.md`; retain their code-specific instructions and define profile/deployment context topics and cross-root dependencies.
- [ ] B4. Create `/opt/agents/README.md`, `/opt/agent-tools/README.md`, `/opt/global-tools/README.md`, each documenting ownership and context IDs. Do not copy secrets or private conversation content into Git documentation.
- [ ] B5. Add missing ownership READMEs in `memory/`, `integrations/` and relevant nested folders where behavior is under active modification.
- [ ] B6. Keep canonical templates in Git `templates/context/` and publish managed copies to `/opt/agent-tools/templates/context/` with an idempotent setup tool.

## Milestone C — Context metadata and resolver

- [ ] C1. Define and validate README frontmatter (`context.id`, `version`, `title`, `topics`, `requires`, `applies_to`, `update_on`) and `.agents/context.yaml` root/document aliases, including cross-platform root overrides.
- [ ] C2. Implement shared `agent-context` CLI in reviewed source code; install at `/opt/agent-tools/bin/agent-context` on Ubuntu and provide a portable invocation for other development hosts.
- [ ] C3. Support `--topic`, `--path`, `--files-changed`, `--format markdown|json`, `validate`, and `explain`. Resolve dependency IDs recursively with deterministic order, deduplication, source paths, Git SHA and inclusion reasons.
- [ ] C4. Reject path traversal, unsafe symlink escapes, duplicate IDs, dependency cycles, absent required roots and malformed metadata. Do not silently trim or omit README content; include opt-in partial output only.
- [ ] C5. Add tests for cross-directory retrieval (Git `agents` + three `/opt` roots), root overrides, missing files, cycles, output determinism and cross-OS paths.

## Milestone D — Harness integrations and README discipline

- [ ] D1. Add `.agents/skills/agent-context/SKILL.md` and invoke the same resolver from OpenCode, Codex, Qwen, Mistral Vibe and other harness-specific entrypoints.
- [ ] D2. Ensure research catalog metadata cannot grant execution privileges or bypass actual Bridge admission, code signing, model allowlists or host isolation.
- [ ] D3. Add CI checks for same-PR nearest-owner README updates on **behavioral** source changes, with justified exemptions for data/profile-only changes.
- [ ] D4. Add a coverage report showing folders lacking READMEs and broken references; do not force a broad docs rewrite to adopt the system.
- [ ] D5. Require source-linked, versioned context bundles in agent handoff messages so a fresh session can reproduce the same context.

## Milestone E — Pilot and acceptance

- [ ] E1. Use Qwen Local ABR-58 as the pilot. Import its reviewed candidate profile in the attached research format; explicitly adapt it into the separate executable Registry v2 only after model, OpenCode syntax and Worker readiness are verified.
- [ ] E2. Confirm a new agent session retrieves `agents/`, `/opt/agents/`, `/opt/agent-tools/`, `/opt/global-tools/`, `bridge/` and the appropriate `jobs/` documentation with one command.
- [ ] E3. Prove independent short-term checkpoint and memU state remains scoped by agent, issue and repository; no long-term promotion happens from README context alone.
- [ ] E4. Pilot on another unrelated coding repository to demonstrate portable roots and templates without Agent Bridge hardcoding.
- [ ] E5. Later generate a versioned, provenance-linked documentation site or separate docs repository from the folder READMEs.

**Excluded:** PostgreSQL control-plane database and UI, production deployments, OAuth setup, service restarts, automatic remote model fallback, and modifications to live Agent Bridge files as part of this document-only package.