# Agent Context C4 — dependency and filesystem safety

**Milestone:** ABR-75 / C4. This milestone hardens the reviewed read-only context resolver. The normal result is **strict and complete**: no selected document or recursive dependency may be omitted without an error.

## Strict-by-default retrieval

An `agent-context --topic profiles`, `--path ...`, or `--files-changed` request:

- Validates the complete C1 `.agents/context.yaml` manifest and source-backed README frontmatter first. Unknown IDs/aliases, duplicate YAML mapping keys, missing metadata, unknown requirements, and dependency cycles are errors.
- Requires every **declared required root** to be present and a real directory. Optional host roots may be absent until their documents are selected.
- Checks every selected README belongs to its declared root and is a real file. It rejects symlinks in the selected document's path or its parents, including symlinks within the root or redirects through a configured host root.
- Refuses absolute `--path` traversal and symlinked selection paths; root-relative paths are validated using the C1 POSIX path contract.
- Rejects installed host README content that differs from its reviewed Git source, rather than mislabeling private or edited content with a Git source SHA.
- Returns **complete, untruncated** README content for every available selected document in Markdown or JSON, with source paths, hashes and inclusion reasons.

The resolver cannot activate a CLI, inspect native private profiles, grant agent permissions or use README text as executable instructions.

## Explicit partial output

**Default:** missing selected optional host documentation produces an error (exit status 2) and no context bundle.

**Opt-in:** `agent-context --topic profiles --allow-partial --format json` returns the fully available documents, sets `partial: true`, and populates `missingDocuments` with each missing document's **ID, root alias, expected source path, inclusion reasons, and error**. The Markdown output has an equally explicit missing-documents section. `explain` still lists the missing documents without including README bodies. When nothing is missing, `partial: false` and `missingDocuments: []`.

Only a genuinely **absent, optional host-root README or host directory** qualifies. The partial flag does **not** suppress errors for:

- Missing roots declared `required: true`.
- Missing Git/repository-owned documents, schemas, or project manifests.
- Unknown or duplicate metadata, undeclared dependencies, or dependency cycles.
- Symlinked paths, path traversal, non-directory roots, non-file README targets or host documentation drift.
- Unsafe or malformed source metadata or Git provenance errors.

`agent-context validate` never accepts `--allow-partial`, because validation must remain complete.

The returned `partial` flag and `missingDocuments` entries are deliberate handoff signals, not evidence that a missing dependency has been satisfied. Consumers must not treat a partial bundle as an authoritative full-context input.

## Verification

Run these source-controlled tests from a reviewed checkout:

- `python3 scripts/test_context_safety.py` — optional/required-root behavior, symlink escape attempts, malformed host paths, source drift, strict vs partial bundles, full-body preservation.
- `python3 scripts/test_agent_context_cli.py` — CLI `--allow-partial` subprocess behavior and `validate` refusal.
- `python3 scripts/test_context_resolver.py` and `python3 scripts/test_context_contract.py` — recursive selection, path ownership, duplicated YAML keys, dependency cycles and malformed metadata.
- `python3 scripts/validate-context-blueprint.py` and `python3 scripts/test_install_agent_context.py` — overarching contract and deterministic, reviewed executable packaging.

The installed Ubuntu `/opt/agent-tools/bin/agent-context` is updated **only after merge** using `python3 scripts/install-agent-context.py --apply`, followed by `--check` and a direct retrieval test. No Bridge service or agent runner changes are part of C4. C5 separately owns expanded cross-OS acceptance and path-portability checks.
