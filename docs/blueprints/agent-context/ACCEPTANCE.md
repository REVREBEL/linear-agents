# Agent Context C5 — cross-root acceptance and portability

**Milestone:** ABR-76 / C5. Acceptance testing for the existing read-only `agent-context` v0.3.0 CLI, not a new agent launcher, context format or production service.

## Test ownership and source fixture

`scripts/test_context_cross_root.py` checks the complete context graph declared in the canonical Git `.agents/context.yaml`. Host documentation comes from the **committed Git blobs** of the three reviewed host-root README sources, installed into disposable test directories selected through the normal `AGENT_CONTEXT_*_ROOT` environment variables. Tests never read native user profile files, change a live `/opt` installation or invoke the Bridge.

The real Git `agents/README.md` and `bridge/README.md` are retrieved alongside all three independently rooted host documents, preserving their canonical IDs, full original text, actual source locations, Git revision, SHA-256 digest, dependency-first order and inclusion reasons. The expected `--topic profiles` order is:

1. `host.global-tools`
2. `host.agent-tools`
3. `host.agent-runtimes`
4. `repo.agents`
5. `repo.bridge`

This order is the tested dependency order of the **current reviewed manifest**. A future intentional dependency change must update the test expectation in the same reviewed PR; no source is silently trimmed or deduplicated away.

## Coverage and failure requirements

The suite tests:

- Full five-document cross-root retrieval using `--topic profiles`, including standalone reviewed Python zipapp execution outside the checkout.
- Exact README bytes and SHA-256/Git-source provenance; recursion, stable order, deduplication, and source-selection reasons.
- Selection by repository-relative `agents/` paths, configured host absolute file paths and the host root directories themselves.
- Deterministic JSON and Markdown content and `explain` mode without README bodies; two direct CLI invocations produce byte-identical JSON given the same source state and root overrides.
- Every host-root environment override taking precedence over the Git manifest's Linux defaults; switching overrides changes source locations but not the reviewed content or hashes.
- Missing host-root README documents: strict mode fails; explicit `--allow-partial` reports each omitted ID, root, expected path and inclusion reasons while retaining all available README bodies.
- Real, isolated Git fixture failures for duplicate YAML document keys, a recursive dependency cycle and missing repository-owned files; opt-in partial output must not conceal any of those failures.
- Real Git `--files-changed` selection across multiple repository owners, with explicit unmatched paths.
- Portable `select_host_root` behavior on `linux`, `darwin` and `win32`; path overrides must use native absolute syntax and root-relative document locators stay POSIX-style regardless of host OS.

## CI platform matrix

The Agent Context workflow runs the new suite both in its established Ubuntu blueprint job and in a **native-host matrix**:

| Runner | Native host path contract | Expected coverage |
| --- | --- | --- |
| `ubuntu-latest` | POSIX Linux paths | Full resolver, Git/host overrides, CLI/zipapp and isolated malformed-file fixtures |
| `macos-latest` | POSIX macOS paths | Same complete acceptance suite, with temporary root paths normalized to handle platform symlink aliases |
| `windows-latest` | Native Windows paths | Same suite with absolute Windows host overrides and POSIX manifest-relative document locators |

The matrix uses Python 3.12 with pinned `PyYAML==6.0.2` and `jsonschema==4.23.0`. A **scoped root `.gitattributes` contract** forces LF checkout bytes for Git-owned context READMEs, source templates and the three packaged CLI modules on all OSes, independent of `core.autocrlf`. Without this, Windows may transform committed LF to CRLF and break the intentional byte-for-byte source checks. The acceptance test verifies the tracked Git attributes rather than silently normalizing content in the resolver.

**Run locally:** `python3 scripts/test_context_cross_root.py`, from a Git checkout after installing the project's existing schema dependencies. The tests require only temporary files and standard Git commands. These are isolated test runs, not permission grants or an `agent-context` CLI installation step.

## Acceptance gate

ABR-76 passes after all native-OS matrix jobs and the original blueprint validator pass, the reviewed PR has no unresolved blocking threads, and the result matches the approved source graph. Existing C1–C4 tests remain part of the Ubuntu validator.

Merge adds tests and documentation. It does not require a production deployment, PostgreSQL work, OAuth changes, a service restart, an additional native CLI install, or copying secrets into Git. Milestone D separately handles skill/harness integration and README update discipline.
