# ABR-83 (D4) — README coverage and broken-reference reporting

The approved D4 milestone is **reporting only**. It inventories all directories containing Git-tracked files and all existing READMEs, and checks local links in those READMEs, the two root coding-agent instruction documents, and Agent Context blueprint Markdown. It does **not** require a repository-wide README migration, modify any documentation automatically, or alter the D3 same-PR enforcement policy.

## Initial reviewed baseline

The complete [baseline report](README_COVERAGE_BASELINE.md) was captured from Git commit `1a138701f8fc99af27b1280e5a8bcc9591935767`. At that snapshot:

| Coverage measure | Finding |
| --- | ---: |
| Tracked files | 844 |
| Tracked README files | 108 |
| Directories with tracked files | 193 |
| Directories with their own README | 107 |
| Directories lacking their own README | 86 |
| Uncovered directories containing behavioral source | 69 |
| Markdown sources checked for local references | 127 |
| Broken local links/references | 3 |

The three local-reference findings are in existing Cloudflare skill documentation: the Durable Objects README references an absent WebSockets README, and the Tunnel README references absent Access and WARP reference directories.

The baseline lists **all 86 uncovered directory paths** and the source file and line number of each broken reference. These findings are informational. This D4 PR does not create missing READMEs, edit Cloudflare skills, or attempt to rewrite external references.

## How the coverage is calculated

The Git-only reporter, [report-readme-coverage.py](../../../scripts/report-readme-coverage.py), reads a **specified Git commit** via read-only Git object commands. It does not scan the live working directory, host tool/runtime directories, untracked private profiles, credentials or network resources.

For each directory represented by tracked files, the report records whether it has its **own** tracked README, the nearest existing ancestor README (if any), total tracked files below it, behavioral files below it, and example behavioral paths. Behavioral classification reuses the D3 [nearest-owner README policy](../../../scripts/check-pr-readme-updates.py), so the coverage report and the same-PR check agree on executable/configuration changes. An ancestor README does not conceal an uncovered nested folder.

For each checked Markdown document, the report verifies locally targeted Markdown links, reference-style definitions/usages and HTML href/src references against the same Git tree. It reports missing tracked file or directory targets, paths escaping the Git root, and undefined reference labels, with source document and line number. Fenced/inline code examples, external URLs, site-root links and heading fragments are excluded from this file-target audit; the report does **not** claim to validate the Internet or heading anchor correctness. Link checks are deliberately scoped to READMEs and the canonical Agent Context documentation, not every archived source.

## Run and retrieve the report

Run from the checkout (no additional Python packages are required):

- `python3 scripts/report-readme-coverage.py` — full Markdown report to stdout.
- `python3 scripts/report-readme-coverage.py --format json` — machine-readable source paths, line numbers, and reasons.
- `python3 scripts/report-readme-coverage.py --ref HEAD --format markdown --output artifacts/readme-coverage.md` — write a Markdown report.
- `python3 scripts/report-readme-coverage.py --ref HEAD --format json --output artifacts/readme-coverage.json` — save structured output.
- `python3 scripts/test_report_readme_coverage.py` — fixture and source-integrity tests.

The [README Coverage Inventory workflow](../../../.github/workflows/readme-coverage-inventory.yml) runs on PRs, pushes to main, and manual dispatch. It posts an advisory GitHub Actions summary and uploads both complete reports as the `readme-coverage-inventory` artifact (retained for 30 days). Existing missing READMEs and broken links **do not fail CI**. The generated artifact is authoritative for the audited commit; this checked-in baseline is a historical snapshot and can differ as the repository evolves.

D3 continues to **block behavioral source modifications where a tracked local owner exists but is not updated in that PR**. D4 makes existing gaps visible and reviewable without granting permission to skip D3 or forcing unrelated documentation edits.

**Next milestone:** D5 introduces source-linked versioned context bundles in agent handoffs. D4 changes no Bridge service, host installation, memory database, OAuth configuration, agent runtime or CLI profile.
