"""Agent Context C3: select and retrieve complete README documentation.

The manifest/frontmatter schema remains authoritative. Documentation text
is returned as data, never executed. The resolver does not create host roots,
install agents, read private sessions or invoke any provider.
"""
from fnmatch import fnmatchcase
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from context_contract import (
    ContextSourceUnavailable, HOST_SOURCE_DOCS, read_frontmatter,
    reject_symlink_components, require_context_source, select_host_root,
    validate_context_contract, validate_relative_document_path,
)


def git(repo_root, *args):
    return subprocess.run(
        ["git", "-C", str(repo_root), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    ).stdout


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _roots(repo_root, manifest, platform, environ):
    """Choose declared aliases without probing or creating private locations."""
    root_paths = {"repo": Path(repo_root).resolve()}
    for alias, config in manifest["roots"].items():
        if alias == "repo":
            continue
        directory = Path(select_host_root(config, platform, environ))
        reject_symlink_components(directory, f"declared root {alias}")
        if directory.exists() and not directory.is_dir():
            raise ValueError(f"Invalid context directory for root {alias}: {directory}")
        if config["required"] and not directory.is_dir():
            raise ValueError(f"Required context root absent: {alias}: {directory}")
        root_paths[alias] = directory
    return root_paths


def _bounded_file(path, root, doc_id, *, optional=False):
    """Accept only a real, symlink-free README under its declared root."""
    return require_context_source(path, root, doc_id, optional=optional)


def _doc_location(repo_root, manifest, root_paths, doc_id):
    locator = manifest["documents"][doc_id]
    root = root_paths[locator["root"]]
    rel = validate_relative_document_path(locator["path"])
    return root, root / rel


def _index(repo_root, manifest, schema):
    """Inspect source-owned metadata; do not require all optional host homes."""
    index = {}
    for doc_id, locator in sorted(manifest["documents"].items()):
        if locator["root"] == "repo":
            source = Path(repo_root) / locator["path"]
        elif locator["root"] != "repo" and (doc_id in HOST_SOURCE_DOCS or locator.get("source")):
            source = Path(repo_root) / (locator.get("source") or HOST_SOURCE_DOCS[doc_id])
        else:
            # Host-only documents without a reviewed Git source remain unindexed.
            continue
        metadata = read_frontmatter(source, schema)
        if metadata["id"] != doc_id:
            raise ValueError(f"Context ID mismatch at {source}: {doc_id}")
        index[doc_id] = metadata
    return index


def _pattern_matches(rel, pattern):
    if fnmatchcase(rel, pattern):
        return True
    if pattern.endswith("/**") and rel == pattern[:-3]:
        return True
    # A recursive glob includes zero directory levels. fnmatchcase alone
    # requires a slash for "**/*" and misses root-level files/directories.
    if "**/" in pattern:
        prefix, suffix = pattern.split("**/", 1)
        return _pattern_matches(rel, prefix + suffix)
    return False


def _owners_for_path(raw, index, manifest, root_paths):
    """Select closest owning README by longest concrete applicability prefix."""
    if not isinstance(raw, str) or not raw:
        raise ValueError("Context selection path must be nonempty")
    possible = []
    if os.path.isabs(raw):
        if "\x00" in raw or ".." in Path(raw).parts:
            raise ValueError(f"Unsafe absolute context selection path: {raw!r}")
        # Do not resolve through an alias or a private symlink. Existing
        # symlinks on any path component are not valid owner-selection paths.
        input_path = Path(raw).absolute()
        reject_symlink_components(input_path, "selection path")
        for alias, root in root_paths.items():
            real_root = root.absolute()
            if input_path.is_relative_to(real_root):
                relative = input_path.relative_to(real_root).as_posix()
                # A host root directory is owned by its root README. Reuse
                # the declared README applicability pattern for selection.
                if relative == "." and alias != "repo":
                    relative = "README.md"
                possible.append((alias, relative))
    else:
        relative = validate_relative_document_path(raw)
        reject_symlink_components(root_paths["repo"] / relative, "selection path")
        possible.append(("repo", relative))
    if not possible:
        raise ValueError(f"Context path outside declared roots: {raw}")
    scores = {}
    for alias, relative in possible:
        for doc_id, metadata in index.items():
            if manifest["documents"][doc_id]["root"] != alias:
                continue
            for pattern in metadata["applies_to"]:
                if _pattern_matches(relative, pattern):
                    # More specific owner beats an ancestor; wildcard
                    # characters are not considered part of the fixed prefix.
                    prefix = pattern.split("*", 1)[0].split("?", 1)[0]
                    scores[doc_id] = max(scores.get(doc_id, -1), len(prefix))
    if not scores:
        return []
    best = max(scores.values())
    return sorted(doc_id for doc_id, score in scores.items() if score == best)


def _changed_files(repo_root):
    """Include tracked/index changes and untracked, non-ignored paths."""
    edited = git(repo_root, "diff", "--no-renames", "--name-only", "-z", "HEAD", "--")
    untracked = git(repo_root, "ls-files", "--others", "--exclude-standard", "-z", "--")
    names = {value.decode("utf-8") for value in (edited + untracked).split(b"\0") if value}
    for name in names:
        validate_relative_document_path(name)
    return sorted(names)


def _choose_seeds(index, manifest, root_paths, *, topic=None, path=None, files_changed=False, repo_root=None):
    reasons, unmatched = {}, []
    if topic is not None:
        if not topic.strip():
            raise ValueError("Topic must not be empty")
        for doc_id, metadata in index.items():
            if topic.casefold() in (value.casefold() for value in metadata["topics"]):
                reasons.setdefault(doc_id, set()).add(f"topic: {topic}")
        label = {"mode": "topic", "value": topic}
    elif path is not None:
        for doc_id in _owners_for_path(path, index, manifest, root_paths):
            reasons.setdefault(doc_id, set()).add(f"path: {path}")
        label = {"mode": "path", "value": path}
    elif files_changed:
        paths = _changed_files(repo_root)
        if not paths:
            raise ValueError("No Git changed or untracked files to select")
        for changed in paths:
            owners = _owners_for_path(changed, index, manifest, root_paths)
            if not owners:
                unmatched.append(changed)
            for doc_id in owners:
                reasons.setdefault(doc_id, set()).add(f"changed file: {changed}")
        label = {"mode": "files-changed", "value": paths}
    else:
        doc_id = manifest["entrypoints"]["default"]
        reasons[doc_id] = {"entrypoint: default"}
        label = {"mode": "default", "value": doc_id}
    if not reasons:
        raise ValueError(f"No owning context documents found for {label['mode']}: {label['value']}")
    return reasons, unmatched, label


def _dependency_order(seed_reasons, index):
    """Stable dependency-first DFS; attach every distinct inclusion reason."""
    reasons = {key: set(value) for key, value in seed_reasons.items()}
    visiting, visited, order = set(), set(), []

    def visit(doc_id):
        if doc_id in visiting:
            raise ValueError(f"Context dependency cycle at {doc_id}")
        if doc_id in visited:
            return
        if doc_id not in index:
            raise ValueError(f"Missing context metadata for required document: {doc_id}")
        visiting.add(doc_id)
        for dep in sorted(index[doc_id]["requires"]):
            reasons.setdefault(dep, set()).add(f"required by: {doc_id}")
            visit(dep)
        visiting.remove(doc_id)
        visited.add(doc_id)
        order.append(doc_id)

    for doc_id in sorted(seed_reasons):
        visit(doc_id)
    return order, {key: sorted(value) for key, value in reasons.items()}


def _source_entry(repo_root, manifest, root_paths, doc_id, metadata, head, reasons, *, explain):
    root, target = _doc_location(repo_root, manifest, root_paths, doc_id)
    locator = manifest["documents"][doc_id]
    optional = (
        locator["root"] != "repo"
        and not manifest["roots"][locator["root"]]["required"]
    )
    _bounded_file(target, root, doc_id, optional=optional)
    # Host README files must exactly match their reviewed Git source before
    # attributing a Git SHA to the installed bytes.
    if manifest["documents"][doc_id]["root"] == "repo":
        git_path = manifest["documents"][doc_id]["path"]
    else:
        git_path = locator.get("source") or HOST_SOURCE_DOCS.get(doc_id)
        if git_path is None:
            raise ValueError(f"No reviewed Git source for host document: {doc_id}")
    raw = target.read_bytes()
    committed = git(repo_root, "show", f"HEAD:{git_path}")
    dirty = raw != committed
    if manifest["documents"][doc_id]["root"] != "repo" and dirty:
        raise ValueError(f"Host context README differs from reviewed Git source: {target}")
    revision = git(repo_root, "log", "-1", "--format=%H", "--", git_path).decode("ascii").strip()
    if len(revision) != 40:
        raise ValueError(f"Cannot determine source Git revision for: {git_path}")
    content = raw.decode("utf-8")
    entry = {
        "id": doc_id,
        "title": metadata["title"],
        "root": manifest["documents"][doc_id]["root"],
        "sourcePath": str(target),
        "gitSourcePath": git_path,
        "gitSha": revision,
        "gitHeadSha": head,
        "sha256": _sha256(raw),
        "worktreeModified": dirty,
        "requires": sorted(metadata["requires"]),
        "reasons": reasons[doc_id],
    }
    if not explain:
        entry["content"] = content
    return entry


def resolve_context(repo_root, *, topic=None, path=None, files_changed=False,
                    explain=False, allow_partial=False, platform=None, environ=None):
    """Resolve complete documents; partial output requires explicit opt-in."""
    base = Path(repo_root).resolve()
    contract = validate_context_contract(base)
    manifest = contract["manifest"]
    schema = json.loads(
        (base / "templates/context/context-frontmatter.schema.json").read_text(encoding="utf-8")
    )
    platform = sys.platform if platform is None else platform
    env = os.environ if environ is None else environ
    roots = _roots(base, manifest, platform, env)
    index = _index(base, manifest, schema)
    selected, unmatched, selection = _choose_seeds(
        index, manifest, roots, topic=topic, path=path,
        files_changed=files_changed, repo_root=base,
    )
    order, reasons = _dependency_order(selected, index)
    head = git(base, "rev-parse", "HEAD").decode("ascii").strip()
    documents, missing_documents = [], []
    for doc_id in order:
        try:
            entry = _source_entry(
                base, manifest, roots, doc_id, index[doc_id], head, reasons,
                explain=explain,
            )
        except ContextSourceUnavailable as exc:
            if not allow_partial:
                raise
            root, target = _doc_location(base, manifest, roots, doc_id)
            missing_documents.append({
                "id": doc_id,
                "root": manifest["documents"][doc_id]["root"],
                "sourcePath": str(target),
                "reasons": reasons[doc_id],
                "error": str(exc),
            })
            continue
        documents.append(entry)
    return {
        "contextVersion": manifest["contextVersion"],
        "project": manifest["project"],
        "gitHeadSha": head,
        "selection": selection,
        "unmatchedPaths": unmatched,
        "partial": bool(missing_documents),
        "missingDocuments": missing_documents,
        "documents": documents,
    }


def render_context(bundle, *, output_format="markdown", explain=False):
    """Show entire README content without truncation; explain omits bodies."""
    if output_format == "json":
        return json.dumps(bundle, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    if output_format != "markdown":
        raise ValueError(f"Unsupported context format: {output_format}")
    lines = [
        "# Agent Context " + ("explanation" if explain else "bundle"),
        "",
        f"- Project: `{bundle['project']}`",
        f"- Git HEAD: `{bundle['gitHeadSha']}`",
        f"- Selection: `{bundle['selection']['mode']}` — `{bundle['selection']['value']}`",
        f"- Documents: {len(bundle['documents'])}",
        f"- Partial: `{str(bundle['partial']).lower()}`",
        "",
    ]
    for item in bundle["documents"]:
        lines.extend([
            f"## {item['title']} (`{item['id']}`)",
            "",
            f"- Source: `{item['sourcePath']}`",
            f"- Git source: `{item['gitSourcePath']}` at `{item['gitSha']}`",
            f"- SHA-256: `{item['sha256']}`",
            f"- Working tree modified: `{str(item['worktreeModified']).lower()}`",
            "- Included because: " + "; ".join(item["reasons"]),
            "",
        ])
        if not explain:
            lines.append(item["content"])
            lines.append("")
    if bundle["missingDocuments"]:
        lines.extend(["## Missing optional context documents (explicit partial output)", ""])
        for item in bundle["missingDocuments"]:
            lines.extend([
                f"- `{item['id']}` — `{item['sourcePath']}`",
                f"  - Error: {item['error']}",
                "  - Requested because: " + "; ".join(item["reasons"]),
            ])
        lines.append("")
    if bundle["unmatchedPaths"]:
        lines.extend(["## Changed paths without context owners", ""])
        lines.extend(f"- `{path}`" for path in bundle["unmatchedPaths"])
        lines.append("")
    return "\n".join(lines)
