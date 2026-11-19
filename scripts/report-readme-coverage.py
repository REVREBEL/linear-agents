#!/usr/bin/env python3
"""ABR-83: advisory tracked README coverage and local-reference audit."""
import argparse
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import runpy
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
classification = runpy.run_path(
    str(Path(__file__).with_name("check-pr-readme-updates.py"))
)["classification"]
INLINE_LINK = re.compile(
    r'!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\.|[^()\s]|\([^()\n]*\))+)(?:\s+["\'][^"\']*["\'])?\s*\)'
)
REFERENCE_DEF = re.compile(r'^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>]+>|[^\s]+)')
REFERENCE_USE = re.compile(r'!?\[([^\]\n]+)\]\[([^\]\n]*)\]')
HTML_LINK = re.compile(r'\b(?:href|src)\s*=\s*["\']([^"\']+)["\']', re.I)
FENCE = re.compile(r'^\s{0,3}(' + chr(96) + r'{3,}|~{3,})')
INLINE_CODE = re.compile(r'(' + chr(96) + r'+).*?\1')
SCHEME = re.compile(r'^[a-z][a-z0-9+.-]*:', re.I)


def git(repo, *args):
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise ValueError("Git source audit failed: "
                         + result.stderr.decode("utf-8", "replace").strip())
    return result.stdout


def tracked_paths(repo, revision):
    git(repo, "rev-parse", "--verify", f"{revision}^{{commit}}")
    return sorted({
        raw.decode("utf-8", "surrogateescape")
        for raw in git(repo, "ls-tree", "-r", "--name-only", "-z", revision, "--").split(b"\0")
        if raw
    })


def directories(paths):
    result = set()
    for source in paths:
        components = source.split("/")
        result.update("/".join(components[:i]) for i in range(1, len(components)))
    return sorted(result)


def coverage(paths):
    tracked = set(paths)
    readmes = {
        p for p in paths if p == "README.md" or p.endswith("/README.md")
    }
    folders = directories(paths)
    behavioral = [p for p in paths if classification(p).startswith("behavioral:")]
    missing = []
    for folder in folders:
        if folder + "/README.md" in tracked:
            continue
        prefix = folder + "/"
        files = [p for p in paths if p.startswith(prefix)]
        changed = [p for p in behavioral if p.startswith(prefix)]
        ancestor = None
        parent = PurePosixPath(folder).parent
        while parent != PurePosixPath("."):
            candidate = parent.as_posix() + "/README.md"
            if candidate in readmes:
                ancestor = candidate
                break
            parent = parent.parent
        missing.append({
            "directory": folder,
            "trackedFilesBelow": len(files),
            "behavioralFilesBelow": len(changed),
            "examples": changed[:3],
            "nearestAncestorReadme": ancestor,
        })
    return {
        "trackedReadmes": len(readmes),
        "foldersTotal": len(folders),
        "foldersWithReadme": len(folders) - len(missing),
        "foldersMissingReadme": len(missing),
        "foldersMissingWithBehavioralFiles": sum(bool(x["behavioralFilesBelow"]) for x in missing),
        "uncoveredFolders": missing,
    }


def documents(paths):
    return sorted(p for p in paths if p == "README.md"
                  or p.endswith("/README.md")
                  or p in {"AGENTS.md", "QWEN.md"}
                  or (p.startswith("docs/blueprints/agent-context/") and p.endswith(".md")))


def visible_lines(data):
    fence, comment = None, False
    for number, raw in enumerate(data.splitlines(), 1):
        marker = FENCE.match(raw)
        if marker and (fence is None or marker.group(1)[0] == fence):
            fence = None if fence else marker.group(1)[0]
            continue
        if fence:
            continue
        line = ""
        tail = raw
        while tail:
            if comment:
                end = tail.find("-->")
                if end < 0:
                    break
                tail, comment = tail[end + 3:], False
            else:
                start = tail.find("<!--")
                if start < 0:
                    line += tail
                    break
                line += tail[:start]
                tail, comment = tail[start + 4:], True
        yield number, INLINE_CODE.sub("", line)


def link_references(data):
    lines = list(visible_lines(data))
    definitions = {}
    for number, line in lines:
        match = REFERENCE_DEF.match(line)
        if match:
            definitions[" ".join(match.group(1).casefold().split())] = match.group(2).strip("<>")
    for number, line in lines:
        definition = REFERENCE_DEF.match(line)
        if definition:
            yield number, "reference-definition", definition.group(2).strip("<>")
            continue
        for match in INLINE_LINK.finditer(line):
            yield number, "markdown-link", match.group(1).strip("<>")
        for match in HTML_LINK.finditer(line):
            yield number, "html-link", match.group(1)
        for match in REFERENCE_USE.finditer(line):
            label = " ".join((match.group(2) or match.group(1)).casefold().split())
            if label not in definitions:
                yield number, "undefined-reference", "[" + label + "]"


def check_target(source, target, tracked, dirs):
    raw = target.strip()
    if not raw or raw.startswith(("#", "/", "\\")) or SCHEME.match(raw):
        return None  # external/anchor URLs are outside the local Git report
    location = unquote(urlsplit(raw).path)
    if not location:
        return None
    if "\0" in location or "\\" in location:
        return {"target": raw, "resolvedPath": None, "reason": "unsafe local link"}
    candidate = posixpath.normpath(posixpath.join(posixpath.dirname(source), location))
    if candidate == ".." or candidate.startswith("../"):
        return {"target": raw, "resolvedPath": candidate, "reason": "link escapes Git root"}
    if candidate == "." or candidate in tracked or candidate in dirs:
        return None
    return {"target": raw, "resolvedPath": candidate, "reason": "missing tracked target"}


def broken_links(repo, revision, paths):
    tracked, dirs = set(paths), set(directories(paths))
    sources, broken = documents(paths), []
    for source in sources:
        data = git(repo, "show", f"{revision}:{source}").decode("utf-8", "replace")
        for line, kind, target in link_references(data):
            if kind == "undefined-reference":
                item = {"target": target, "resolvedPath": None,
                        "reason": "undefined Markdown reference"}
            else:
                item = check_target(source, target, tracked, dirs)
            if item is not None:
                broken.append({"document": source, "line": line, "kind": kind, **item})
    return {
        "documentsChecked": len(sources),
        "brokenReferenceCount": len(broken),
        "brokenReferences": sorted(broken, key=lambda x: (x["document"], x["line"], x["target"])),
    }


def audit(repo=ROOT, ref="HEAD"):
    repo = Path(repo).resolve()
    commit = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
    paths = tracked_paths(repo, commit)
    return {
        "schemaVersion": 1,
        "sourceCommit": commit,
        "scope": "Git tracked folders, READMEs, root AGENTS/QWEN and context blueprint Markdown",
        "enforcement": "advisory",
        "trackedFiles": len(paths),
        **coverage(paths),
        **broken_links(repo, commit, paths),
    }


def markdown(report):
    tick = chr(96)
    result = [
        "# README coverage and broken local references",
        "",
        "Git commit: " + tick + report["sourceCommit"] + tick,
        "",
        "**Advisory report** — no PR failures or forced README migration.",
        "Uses reviewed Git files only; external URLs and heading fragments are not checked.",
        "",
        "## Summary",
        "",
    ]
    for key, label in [
        ("trackedFiles", "Tracked files"),
        ("trackedReadmes", "Tracked READMEs"),
        ("foldersTotal", "Tracked directories"),
        ("foldersWithReadme", "Directories with README"),
        ("foldersMissingReadme", "Directories lacking README"),
        ("foldersMissingWithBehavioralFiles", "Uncovered directories with behavioral source"),
        ("documentsChecked", "Markdown sources inspected"),
        ("brokenReferenceCount", "Broken local references"),
    ]:
        result.append("- " + label + ": **" + str(report[key]) + "**")
    result += ["", "## Directories without an own README", "",
               "| Directory | Behavioral files below | Nearest ancestor README |",
               "| --- | ---: | --- |"]
    for row in report["uncoveredFolders"]:
        owner = row["nearestAncestorReadme"] or "None"
        result.append("| " + tick + row["directory"] + tick + " | "
                      + str(row["behavioralFilesBelow"]) + " | " + tick + owner + tick + " |")
    result += ["", "## Broken local references", ""]
    if report["brokenReferences"]:
        result += ["| Source | Target | Reason |", "| --- | --- | --- |"]
        for entry in report["brokenReferences"]:
            source = entry["document"] + ":" + str(entry["line"])
            target = entry["target"].replace("|", "&#124;")
            result.append("| " + tick + source + tick + " | " + tick + target
                          + tick + " | " + entry["reason"] + " |")
    else:
        result.append("No broken local targets found within the audited sources.")
    result += [
        "", "## Scope", "",
        "- Folder ownership uses the same behavioral classification as D3.",
        "- Each tracked directory is counted even if a parent has a README.",
        "- Broken links cover README and selected project-instruction/blueprint Markdown;",
        "  local targets must exist in Git. No external HTTP checks or heading-anchor checks.",
        "- A separate JSON report includes paths, source lines and examples.",
        "- D3 same-PR enforcement remains unchanged; D4 findings are informational.",
        "",
    ]
    return "\n".join(result)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        result = audit(args.repo, args.ref)
    except (ValueError, OSError) as exc:
        print(f"README coverage audit could not run: {exc}", file=sys.stderr)
        return 2
    body = markdown(result) if args.format == "markdown" else json.dumps(
        result, indent=2, sort_keys=True, ensure_ascii=False
    ) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body, encoding="utf-8")
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
