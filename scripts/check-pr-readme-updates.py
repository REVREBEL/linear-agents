#!/usr/bin/env python3
"""ABR-79: require the nearest tracked README in behavioral source PRs.

Compares the effective PR delta (merge-base(base, head) -> head), not the
working tree. Data/profile-only, test-only and documentation changes are
exempt with fixed, auditable reasons. Unowned paths are reported for D4
coverage rather than forcing a repository-wide README migration.
"""
import argparse
from dataclasses import dataclass
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys


BEHAVIORAL_SUFFIXES = frozenset({
    ".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash",
    ".zsh", ".sql", ".json", ".jsonc", ".yaml", ".yml", ".toml",
    ".ini", ".conf", ".css", ".scss", ".html", ".tf", ".tfvars",
})
SPECIAL_BEHAVIORAL = frozenset({
    "Dockerfile", "Containerfile", "Makefile", ".env.example",
    "requirements.txt", "Pipfile", "Gemfile", "go.mod", "go.sum",
    "Cargo.lock", "Cargo.toml", ".terraform.lock.hcl",
})
PROFILE_DATA_PREFIXES = (
    "agents/profiles/candidates/", "agents/profiles/research/",
)
PROFILE_DATA_FILES = frozenset({"agents/agent-registry.yaml"})
DATA_SUFFIXES = frozenset({
    ".yaml", ".yml", ".json", ".csv", ".tsv",
})
DOCUMENT_SUFFIXES = frozenset({
    ".md", ".mdx", ".rst", ".txt", ".csv", ".tsv", ".png", ".jpg",
    ".jpeg", ".webp", ".svg", ".gif", ".pdf", ".lock",
})


@dataclass(frozen=True)
class Change:
    status: str
    old_path: str | None
    new_path: str | None


def git(repo, *args):
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise ValueError(
            "Git diff cannot be verified: "
            + result.stderr.decode("utf-8", "replace").strip()
        )
    return result.stdout


def safe_path(raw):
    value = raw.decode("utf-8", "surrogateescape")
    if (not value or value.startswith("/") or "\\" in value
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError(f"Unsafe PR path: {value!r}")
    return value


def diff_changes(repo, base, head):
    # Fail if either revision cannot be resolved; never silently compare an
    # arbitrary branch or use dirty local files as a PR substitute.
    for revision in (base, head):
        git(repo, "rev-parse", "--verify", f"{revision}^{{commit}}")
    raw = git(
        repo, "diff", "--name-status", "-z", "--find-renames",
        "--diff-filter=ACDMRT", f"{base}...{head}", "--",
    )
    tokens = raw.split(b"\0")
    if tokens[-1] != b"":
        raise ValueError("Malformed NUL-delimited Git change list")
    tokens.pop()
    changes = []
    cursor = 0
    while cursor < len(tokens):
        status = tokens[cursor].decode("ascii")
        cursor += 1
        if not status or status[0] not in "ACDMRT":
            raise ValueError(f"Unsupported Git status: {status!r}")
        two_paths = status[0] in "RC"
        count = 2 if two_paths else 1
        if cursor + count > len(tokens):
            raise ValueError(f"Incomplete Git change entry: {status}")
        names = [safe_path(part) for part in tokens[cursor:cursor + count]]
        cursor += count
        old_path = names[0] if two_paths or status[0] != "A" else None
        new_path = names[-1] if status[0] != "D" else None
        changes.append(Change(status, old_path, new_path))
    return changes


def tracked_readmes(repo, ref):
    return {
        safe_path(raw)
        for raw in git(repo, "ls-tree", "-r", "--name-only", "-z", ref, "--").split(b"\0")
        if raw and (raw == b"README.md" or raw.endswith(b"/README.md"))
    }


def nearest_readme(path, readmes):
    """Prefer physically nearest README, not a broader glob/context dependency."""
    parent = PurePosixPath(path).parent
    if parent == PurePosixPath("."):
        return "README.md" if "README.md" in readmes else None
    while parent != PurePosixPath("."):
        candidate = f"{parent.as_posix()}/README.md"
        if candidate in readmes:
            return candidate
        parent = parent.parent
    # A subdirectory without an owning README is a D4 coverage gap, not an
    # implicit mandate to rewrite the repository's top-level README.
    return None


def classification(path):
    lower = path.lower()
    name = PurePosixPath(path).name
    suffix = PurePosixPath(path).suffix.lower()
    if ((path in PROFILE_DATA_FILES or
         any(path.startswith(prefix) for prefix in PROFILE_DATA_PREFIXES))
            and suffix in DATA_SUFFIXES):
        return "exempt: research candidate/catalog data (not runtime behavior)"
    if lower.endswith("/readme.md") or lower == "readme.md":
        return "exempt: documentation"
    if (lower.startswith("docs/") and suffix in DOCUMENT_SUFFIXES) or (
        suffix in DOCUMENT_SUFFIXES and name != "SKILL.md"
        and name not in SPECIAL_BEHAVIORAL
    ):
        return "exempt: documentation/static asset"
    if (any(part in {"test", "tests", "__tests__", "fixtures", "__fixtures__"}
            for part in PurePosixPath(path).parts)
        or name.startswith(("test_", "conftest."))
        or any(name.endswith(mark) for mark in (
            ".test.mjs", ".test.cjs", ".test.js", ".test.ts",
            ".test.tsx", ".spec.mjs", ".spec.js", ".spec.ts",
            ".spec.tsx", "_test.py",
        ))):
        return "exempt: test or isolated fixture only"
    if name == "SKILL.md" and path.startswith(".agents/skills/"):
        return "behavioral: agent skill instructions"
    if name in SPECIAL_BEHAVIORAL or suffix in BEHAVIORAL_SUFFIXES:
        return "behavioral: code, configuration, schema or migration"
    return "exempt: non-executable asset"


def check_pr(repo, base, head):
    changes = diff_changes(repo, base, head)
    merge_base = git(repo, "merge-base", base, head).decode("ascii").strip()
    before = tracked_readmes(repo, merge_base)
    after = tracked_readmes(repo, head)
    touched = {
        candidate for change in changes
        for candidate in (change.old_path, change.new_path)
        if candidate and candidate.endswith("README.md")
    }
    updated = touched & after
    failures, unowned, exemptions, covered = [], [], [], []
    seen = set()
    for change in changes:
        candidates = (
            ((change.old_path, before), (change.new_path, after))
            if change.status.startswith(("R", "C"))
            else (
                ((change.new_path, before),)
                if (change.old_path and change.new_path
                    and (old_owner := nearest_readme(change.old_path, before))
                    and old_owner not in after)
                else (((change.new_path, after),) if change.new_path
                      else ((change.old_path, before),))
            )
        )
        for path, owners in candidates:
            if path is None or path in seen:
                continue
            seen.add(path)
            reason = classification(path)
            if reason.startswith("exempt:"):
                exemptions.append({"path": path, "reason": reason})
                continue
            owner = nearest_readme(path, owners)
            if owner is None:
                unowned.append({"path": path, "reason": reason})
            elif owner not in after or owner not in updated:
                failures.append({
                    "path": path, "readme": owner,
                    "reason": "nearest owning README not updated in this PR",
                })
            else:
                covered.append({"path": path, "readme": owner})
    return {
        "changes": len(changes), "covered": covered, "missing": failures,
        "unowned": unowned, "exemptions": exemptions,
        "passed": not failures,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="Git PR base commit SHA")
    parser.add_argument("--head", required=True, help="Git PR head commit SHA")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json", action="store_true", help="emit structured result")
    args = parser.parse_args(argv)
    try:
        result = check_pr(args.repo, args.base, args.head)
    except (ValueError, OSError) as exc:
        print(f"README discipline check could not run: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(
            f"PR README discipline: {result['changes']} changes; "
            f"{len(result['covered'])} behavioral paths covered; "
            f"{len(result['exemptions'])} justified exemptions; "
            f"{len(result['unowned'])} D4 ownership gaps."
        )
        for item in result["exemptions"]:
            print(f"EXEMPT {item['path']}: {item['reason']}")
        for item in result["covered"]:
            print(f"MATCH {item['path']} -> {item['readme']}")
        for item in result["unowned"]:
            print(f"UNOWNED (D4 advisory) {item['path']}: {item['reason']}")
        for item in result["missing"]:
            print(
                f"ERROR {item['path']}: update the nearest owning "
                f"{item['readme']} in the same PR",
                file=sys.stderr,
            )
        print("PASS" if result["passed"] else "FAIL: missing same-PR README updates")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
