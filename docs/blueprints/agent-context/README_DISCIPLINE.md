# ABR-79 (D3) — Same-PR owning README discipline

The `Owning README Discipline` GitHub Actions workflow checks **every pull request** for behavioral changes and requires the physically nearest **tracked** owning `README.md` to be updated in that same PR. This is an incremental, reviewable documentation rule, not a request to recreate every missing README.

## Ownership and changes

`scripts/check-pr-readme-updates.py` compares the **effective Git PR diff** between the merge base and head commit, using `git diff --name-status -z --find-renames BASE...HEAD`. It never guesses from the local working tree, issue labels, PR descriptions, or a single commit. It handles additions, modifications, deletions, renames, and type changes.

For each behavioral file, walk up from its directory and choose the **closest tracked `README.md`**. A nested `jobs/admission/README.md` owns `jobs/admission/handler.mjs` ahead of `jobs/README.md`; `integrations/litellm/README.md` owns its adapter ahead of `integrations/README.md`. This filesystem ownership rule complements the logical `.agents/context.yaml` dependency graph: cross-root `requires` entries supply reading context, not multiple documentation-update obligations.

The owning README must **exist at PR head and have an effective change in the same PR**. Changing only an ancestor README does not satisfy a nested owner. Deleting a nested owner does not silently transfer its obligation to an ancestor. For renames across owners, both old and new ownership are examined. Root-level behavioral files use root `README.md` only; nested paths with no local owner are reported as D4 coverage gaps rather than implicitly assigned to the top-level README.

Behavioral source includes JavaScript/TypeScript/Python/shell source, SQL migrations, provider/Worker configuration, JSON/YAML/TOML schema or configuration, CSS and selected dependency/build manifests. Repository-local agent `SKILL.md` changes are behavioral instructions and require the nearest owner under `.agents/`. Content changes need a real Git file delta; merely mentioning a README in a comment cannot satisfy the check.

## Deterministic exemptions, with reasons

The checker automatically reports the exemption reason for each changed file that does not itself require an owning README.

| Change kind | Reason |
| --- | --- |
| `agents/profiles/candidates/*.yaml`, `agents/profiles/research/*.yaml` and equivalent JSON/YAML data; `agents/agent-registry.yaml` | Research/profile **data-only**; these records cannot register executable agents or change dispatch by themselves |
| README/doc Markdown, static images and similar assets | Documentation/static asset, not behavioral source |
| Dedicated `*.test.*`, `*.spec.*`, `test_*.py` and isolated fixture paths | Test/fixture-only; the tests describe behavior rather than changing deployed behavior |
| Other non-executable assets | Non-runtime source |

Exemptions are **file-specific, not PR-wide**: a PR containing both a research YAML change and a runtime/registry change must still update the runtime owner's README. A research schema or executable Registry v2 configuration change is **not exempt**. There is no `skip-ci` label, PR-body checkbox or unreviewed author override. When a policy classification is genuinely wrong, adjust its narrow rule with regression tests in a separately reviewed change.

## Unowned source paths and D4

If a behavioral file has no tracked README in its directory/ancestor hierarchy (excluding root fallback for nested paths), the check reports `UNOWNED (D4 advisory)` with the exact path. It does not fail that PR or force a broad documentation migration. **ABR-80 / D4** will inventory these coverage gaps and broken links. As new READMEs are added and tracked, same-PR enforcement activates automatically for their descendants.

## Maintainer and CI verification

From a full Git checkout:

`python3 scripts/check-pr-readme-updates.py --base <base-commit-sha> --head <pr-head-sha>`

`python3 scripts/check-pr-readme-updates.py --base <base-commit-sha> --head <pr-head-sha> --json`

`python3 scripts/test_pr_readme_updates.py`

Exit code `0` means all currently owned behavioral files have same-PR README updates; exit `1` identifies missing updates; exit `2` means Git refs or diff data could not be validated. The JSON report includes `covered`, `missing`, `unowned`, and `exemptions` with reasons.

The dedicated workflow `.github/workflows/owning-readme-discipline.yml` runs on **all** opened, synchronized and reopened PRs (including draft-ready transitions), with `contents: read` permission and full Git history. It runs the self-tests, then compares the actual `github.event.pull_request.base.sha` and `head.sha`. A clean result does not mean every folder is documented; it means **every behavioral file with an existing local owner** received a matching README change.

The CI check neither executes changed source modules nor deploys, restarts or authorizes any Bridge agent. Its only purpose is incremental documentation correctness.
