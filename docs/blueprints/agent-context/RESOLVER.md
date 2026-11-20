# Agent Context C3 — source-linked README retrieval

**Milestone:** ABR-74 / C3. The same `agent-context` Python CLI that validates project metadata can now select owning READMEs, recursively include their declared dependencies, preserve full content, and explain why each document appears.

## Commands

From a checkout use `python3 scripts/agent_context_cli.py`, or from the merged/install-verified Ubuntu CLI use `/opt/agent-tools/bin/agent-context` with these options:

| Command | Meaning |
| --- | --- |
| `agent-context validate` | Validate the C1 manifest, schemas, cross-document IDs and dependency graph without reading the host trees |
| `agent-context --topic profiles` | Select all README owners declaring the given topic (case-insensitive exact match) and their transitive requirements |
| `agent-context --path memory/migrations/001_agent_checkpoints.sql` | Select the most specific matching owner according to the `applies_to` patterns, then include its prerequisites |
| `agent-context --files-changed` | Read Git working tree/index changes relative to `HEAD`, plus untracked non-ignored files; deduplicate owners and report unmatched changed paths |
| `agent-context --topic profiles --format json` | Emit complete source-linked JSON rather than Markdown |
| `agent-context explain --topic profiles` | Show the same selected IDs, source paths, dependency order and inclusion reasons, without README bodies |
| `agent-context --path agents/registry.json --format json explain` | Explain path selection as machine-readable JSON |

No selector uses the `entrypoints.default` alias (`repo.bootstrap`) and follows its declared dependencies. Selectors are mutually exclusive, and `--repo-root /path/to/project` or `AGENT_CONTEXT_REPO_ROOT` remains available for disambiguation. The nearest manifest discovered from the working directory always wins; a nested incomplete project fails validation rather than falling back to its parent.

## Selection semantics

- `--topic` selects documents whose `context.topics` include the requested token. Different owners may share a topic; they are included together before deduplication.
- `--path` normally accepts a root-relative POSIX repository path; an absolute path is permitted only if it falls inside a configured root, including an explicit `AGENT_CONTEXT_*_ROOT` host override. The best/nearest owner has the longest concrete prefix of a matching `context.applies_to` pattern. Filesystem contents at the requested path are not read.
- `--files-changed` uses Git to determine tracked and untracked paths, then performs the same most-specific-owner lookup per path. Paths with no owner are explicitly listed in `unmatchedPaths`. If no path has an owner or there are no changed files, the command reports an error instead of silently returning default context.
- Every source-backed required document is included recursively, once, in deterministic dependency-first order. All distinct inclusion reasons are retained and sorted (e.g. `topic: profiles` or `required by: repo.bridge`).
- The resolver strictly rejects missing selected dependencies and README drift by default. C4 adds symlink/path hardening and explicit `--allow-partial` for **missing optional host docs only**, recorded under `partial` and `missingDocuments`; see [C4 safety policy](SAFETY.md).

## C4 safety and explicit partial results (ABR-75)

The default resolver refuses absent required roots, missing selected source documents, symlink escapes, invalid dependency graphs, malformed source metadata, or drifted host READMEs. `--allow-partial` is a deliberate opt-in for genuinely missing **optional host documentation only**, never for unsafe paths or invalid metadata. It preserves all available README content in full and reports omitted IDs, expected source paths, reasons and errors in `missingDocuments`, with `partial: true` in both Markdown and JSON formats. `validate` does not support partial results. See [SAFETY.md](SAFETY.md) for the exact classification and tests.

## Provenance and contents

Markdown includes each document's ID, title, actual source path, canonical Git-source path, source Git commit SHA, SHA-256 content digest, modified-working-tree status, and inclusion reasons, then the **complete README body including its original frontmatter**. JSON returns the equivalent structured fields and an untruncated `content` string per document; `explain` omits only that `content` field.

The bundle also records `contextVersion`, `project`, `gitHeadSha`, the requested selector and `unmatchedPaths` when applicable. For Git repo README changes not yet committed, `worktreeModified: true` makes the difference from the indicated Git SHA explicit. A live host README is only attributed to a Git revision after a byte-for-byte comparison with its reviewed Git source under `templates/context/host-roots/`.

Neither `gitSha`, a README, a research profile, nor a topic match grants agent execution, file-reading beyond selected documentation, GitHub/Linear authorization, provider credentials, or production deployment.

## Test and installation flow

Run `python3 scripts/test_context_resolver.py`, `python3 scripts/test_agent_context_cli.py` and `python3 scripts/test_install_agent_context.py` in a clean reviewed checkout. Tests use temporary host roots and Git fixtures so no real native CLI profile or service state changes.

After an approved resolver change merges, run the reviewed `scripts/install-agent-context.py --apply` and `--check` on Ubuntu, then confirm direct CLI retrieval and that all available README contents remain complete. If a Git-owned host README changes, reconcile it separately through `scripts/reconcile-host-root-readmes.py`. C4's path/partial behavior is documented in [SAFETY.md](SAFETY.md); C5 owns expanded cross-platform acceptance.
