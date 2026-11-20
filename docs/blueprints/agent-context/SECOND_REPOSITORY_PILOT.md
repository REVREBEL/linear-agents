# ABR-88 (E4) — Portable Agent Context in a second coding repository

**Result (November 19, 2026, Pacific): Passed on an unrelated Payload/Next.js TypeScript coding checkout.** This is an independent Git repository, not a nested Agent Bridge module or Worker. The original application checkout remained untouched; the test copied its committed Git history into a disposable local clone and deleted that clone after verification.

## Actual second-repository evidence

- **Application:** Existing Payload/Next.js repository on Ubuntu, source checkout `/home/rebel/payload/revrebel`, source revision `2aa09f37209b804e819ce3b41fc3af8bedc0c166` (`feat: initial commit`). That local checkout did not advertise a remote URL, so its GitHub identity is not asserted.
- **Isolation:** `git clone --local --no-hardlinks` into a temporary `/tmp/abr88-live-payload-*/payload-nextjs` directory. The independent README metadata, portable CLI and two custom Git-owned host README templates were added and committed **in the disposable clone only**. No production files or private host profiles were changed.
- **Independent manifest:** `project: independent-nextjs-cms`; no `agent-bridge`, `repo.bridge`, `host.agent-runtimes` or canonical Bridge Registry v2 identifiers. The actual tracked `src/collections/Users.ts` was present and resolved to `repo.collections`.
- **Host roots:** `host.design-system` and `host.toolchain`, each with a custom root alias and environment override, plus an explicit reviewed Git README `source`. These were served from disposable paths, not the Bridge's three `/opt` READMEs.
- **Observed result:** `validate` accepted **five** source-backed README contracts. One `--topic collections --format json` invocation returned four complete documents, in dependency-first order: `host.toolchain`, `host.design-system`, `repo.application`, `repo.collections`. All content hashes matched the independent clone's Git blobs; `partial: false`, with no missing documents.
- **Reproducible handoff:** A D5 JSON handoff for `REVREBEL/payload-nextjs-pilot` created in that clone passed `verify --check-source` after both disposable host documentation directories were removed. The handoff did not run an agent or authorize a deployment.

## Portable configuration and one-command usage

The complete metadata example lives at `docs/blueprints/agent-context/examples/nextjs-app/`. An unrelated repository can adapt the sample `.agents/context.yaml`, the three owning Git README files, and two Git-owned host sources, then copy the **portable** Python modules `agent_context_cli.py`, `context_contract.py`, `context_resolver.py` and optionally `agent-context-handoff.py`, plus the two context JSON schemas.

Example after configuring independent host README root paths:

`python3 scripts/agent_context_cli.py --topic collections --format json`

The v1 manifest accepts an **optional `documents.<id>.source`** for any non-repository README locator. It is a safe, repo-relative reviewed Git path, distinct from the actual host `root` and `path`. This permits `host.design-system` and `host.toolchain` without editing the resolver for each new project. Legacy Bridge-owned host aliases (`host.agent-runtimes`, `host.agent-tools`, `host.global-tools`) retain their strict historical IDs, document paths and fixed canonical Git sources; a conflicting explicit source is rejected. Repository-owned documents still use their own `path` and cannot redirect `source` to another file.

The resolver uses the custom source for frontmatter, full Git provenance, exact host-byte verification, topic/path selection, optional-host partial failures, and D5 pinned selection replay. It does not fetch arbitrary internet documents, infer shell commands, or turn readme text into authority. All required files must be installed explicitly by the receiving repository; the example makes no changes to unrelated real checkouts.

## Repeatable, cross-platform acceptance

`python3 scripts/test_context_second_repo.py` creates a **fresh independent Git coding repository** from the example, with TypeScript `src/app/page.tsx` and `src/collections/Users.ts`. It copies only portable CLI modules and schemas, commits its own initial tree, and uses two independent disposable host root overrides. Ten tests cover:

- Independent contract validation and absence of Agent Bridge-specific roots/IDs.
- Complete deterministic source-linked retrieval and SHA-256 verification from a new interpreter, independent of the invoking working directory.
- Topic, closest owner path, default bootstrap and Git changed-file selection for actual TypeScript files.
- Strict missing host failure, opt-in partial disclosure and rejection of drifted host documents.
- Unsafe/escaping custom Git source paths and metadata ID mismatch.
- Complete D5 source-pinned handoff replay after original host directories disappear.

The Agent Context Blueprint CI runs this test in both its Ubuntu validation job and the native Ubuntu/macOS/Windows matrix. It also preserves all existing C1–C5 and D5 tests for the original Bridge aliases.

**Scope:** Documentation/context template portability only. No changes to the independent production application, hosted service, credentials, OAuth, PostgreSQL UI, or running Bridge. This pilot is not a live model/Worker dispatch or memU deployment.
