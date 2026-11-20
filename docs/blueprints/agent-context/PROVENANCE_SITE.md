# ABR-89 (E5) — Versioned, source-linked README documentation site

The consolidated documentation output is a **static HTML site generated from committed Git folder READMEs**, not a new source of truth. Folder READMEs and the existing Context v1 contracts retain ownership. The output includes a navigable rendered page for each README, the exact original Markdown, and machine-readable per-source provenance. It does not replace the Context CLI or grant agent execution authority.

## Build a site

From a reviewed checkout with Python 3.10+, markdown-it-py==3.0.0 and PyYAML==6.0.2:

    python3 scripts/build_context_docs_site.py build --repo-root . --repository REVREBEL/linear-agents --output /tmp/agent-context-docs

Open **/tmp/agent-context-docs/index.html** in a browser or hand the directory to a separately approved static-hosting process.

| Artifact | Contents |
| --- | --- |
| index.html | Navigable index grouped by top-level source folder |
| pages/…/index.html | Safe CommonMark rendering, document navigation, source links, provenance |
| sources/…/README.md | **Unmodified original README Git blob bytes** |
| provenance.json | Schema version, Git source HEAD/tree, build ID, SHA-256 and last-changing Git commit per README, blob SHA and immutable GitHub link |
| assets/style.css | Standalone styles; no JavaScript or external rendering dependency |

**Selection:** Every tracked file named exactly README.md in the pinned Git commit. This includes nested folders and Git-owned skill-reference READMEs. No arbitrary truncation or silent exclusion. The generator uses **Git tree/blob objects**, not the working tree, and never reads host-installed /opt roots, private profiles, secrets, runtime task data or untracked files.

**Source versioning:** The schemaVersion (1), sourceCommit, sourceTree and buildId identify a reproducible documentation snapshot. buildId is the first 16 hex characters of a SHA-256 over canonical JSON describing source commit, repository identity and ordered per-file provenance. The manifest includes per-file Git blob SHA, original last-modifying commit, SHA-256 and file paths. Each HTML page links to its original Markdown and immutable GitHub blob source.

**Rendering:** CommonMark renders with raw HTML disabled. Links to other included README files navigate within the generated site; other safe repository-relative links target the pinned GitHub commit. Unsafe URI schemes, relative path escapes and absolute host paths never become local filesystem access. Source text is documentation, not permission to execute instructions.

## Determinism and drift verification

    python3 scripts/build_context_docs_site.py check --repo-root . --repository REVREBEL/linear-agents --output /tmp/agent-context-docs

The read-only check regenerates the expected inventory from the pinned commit and compares **every output byte**, refusing stale or modified pages, altered Markdown sources, unexpected files, missing pages or symlinks. The build command accepts **only a new destination outside the Git checkout**, refusing overwrites. It stages all files in a temporary sibling directory and renames the complete build into place.

Run the isolated acceptance suite:

    python3 scripts/test_context_docs_site.py

Twelve tests cover an independent fresh Git repository, source hash and Git revision identity, deterministic builds from different working directories, safe Markdown rendering and relative links, uncommitted edits being excluded, new source revision drift, changed pages and original blobs, unsafe and symlinked paths, and output-write boundaries. Tests use disposable local fixtures with no real bridge or provider.

## CI artifact delivery

The [Source-linked README Documentation Site workflow](../../../.github/workflows/agent-context-docs-site.yml) runs for relevant README/generator changes in pull requests and main pushes, and supports manual **Run workflow**. It checks out the actual head commit with full history, installs pinned Markdown dependencies, runs twelve tests, generates and checks the site, then uploads a read-only GitHub Actions artifact called:

    source-linked-readme-site-<full-Git-commit-SHA>

Download the run artifact, extract it, and open index.html. It includes Git-tracked hidden .agents README folders, and is retained for **30 days**. The site is never written back to the repository. The workflow has **contents: read** GitHub permissions, with no hosting, publishing, remote app deployment, OAuth, PostgreSQL, or service restart.

## E5 evidence

A local Ubuntu build of the existing Agent Bridge tree at revision 6a9281db6cfe4447beb6324e089897c5dd0c7f46 generated **114 complete README HTML pages**, **114 exact original Markdown sources**, index and source provenance manifest. A second check verified the entire output byte-for-byte. CI repeats the proof on the PR's new committed source revision. Deployment to a hosted site or separate docs repository remains a separate approved action.
