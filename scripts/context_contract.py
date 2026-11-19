"""Agent Context v1 metadata contracts (ABR-72).

Pure schema/reference validation and platform-root selection; no filesystem
resolution, CLI invocation, provider credentials, or runtime activation.
"""
import json
import os
import re
from pathlib import Path, PurePosixPath, PureWindowsPath
import posixpath

import yaml
from jsonschema import Draft202012Validator


HOST_SOURCE_DOCS = {
    "host.agent-runtimes": "templates/context/host-roots/agents/README.md",
    "host.agent-tools": "templates/context/host-roots/agent-tools/README.md",
    "host.global-tools": "templates/context/host-roots/global-tools/README.md",
}
HOST_DOCUMENT_ROOTS = {
    "host.agent-runtimes": "host-agents",
    "host.agent-tools": "host-agent-tools",
    "host.global-tools": "host-global-tools",
}
PLATFORMS = frozenset({"linux", "darwin", "win32"})


class ContextSourceUnavailable(ValueError):
    """An optional context document/root is absent, not unsafe or malformed."""


def reject_symlink_components(path, label):
    """Refuse existing symlink components, not just a final README symlink.

    This is intentionally stricter than resolving and following a path:
    private profile homes and outside files are never used as substitutes for
    a reviewed context document or for a requested selection path.
    """
    value = Path(path).absolute()
    for component in (value, *value.parents):
        if component.is_symlink():
            raise ValueError(f"Unsafe symlink in context {label}: {component}")


def require_context_source(path, root, doc_id, *, optional=False):
    """Return a real file within a real declared root; classify absence only.

    Only a genuinely absent optional host source may be reported as partial.
    Invalid paths, symlink components and other safety failures always raise.
    """
    directory = Path(root).absolute()
    source = Path(path).absolute()
    reject_symlink_components(directory, f"root for {doc_id}")
    reject_symlink_components(source, f"source for {doc_id}")
    if not source.is_relative_to(directory):
        raise ValueError(f"Context source escapes declared root for {doc_id}: {source}")
    if directory.exists() and not directory.is_dir():
        raise ValueError(f"Context root is not a directory for {doc_id}: {directory}")
    if source.exists() and not source.is_file():
        raise ValueError(f"Context source is not a regular file for {doc_id}: {source}")
    if not directory.is_dir() or not source.is_file():
        detail = f"Context source missing for {doc_id}: {source}"
        if optional:
            raise ContextSourceUnavailable(detail)
        raise ValueError(detail)
    if not source.resolve().is_relative_to(directory.resolve()):
        raise ValueError(f"Context source escapes declared root for {doc_id}: {source}")
    return source


class UniqueMappingLoader(yaml.SafeLoader):
    """Duplicate keys must fail, especially duplicate document IDs."""


def _unique_mapping(loader, node):
    loader.flatten_mapping(node)
    output = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        if not isinstance(key, str):
            raise ValueError(f"Context YAML requires string keys, got {key!r}")
        if key in output:
            raise ValueError(f"Duplicate context YAML key: {key}")
        output[key] = loader.construct_object(value_node, deep=True)
    return output


UniqueMappingLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping
)


def load_unique_yaml(content):
    return yaml.load(content, Loader=UniqueMappingLoader)


def _check_schema(data, schema, label):
    errors = sorted(Draft202012Validator(schema).iter_errors(data),
                    key=lambda e: "/".join(map(str, e.absolute_path)))
    if errors:
        error = errors[0]
        where = "/".join(map(str, error.absolute_path)) or "<root>"
        raise ValueError(f"{label} at {where}: {error.message}")


def _path_segments(path):
    return re.split(r"[/\\]+", path)


def _native_absolute(path, platform):
    if not isinstance(path, str) or not path or "\x00" in path or ".." in _path_segments(path):
        return False
    if platform == "win32":
        return PureWindowsPath(path).is_absolute()
    if platform in ("linux", "darwin"):
        return PurePosixPath(path).is_absolute() and "\\" not in path
    raise ValueError(f"Unsupported context platform: {platform}")


def select_host_root(config, platform, environ=None):
    """Choose an absolute root path; environment > OS default > base default.

    This selects a *path string*, without testing or creating host directories.
    A non-native default requires an explicit platform default or env override.
    """
    if platform not in PLATFORMS:
        raise ValueError(f"Unsupported context platform: {platform}")
    env = os.environ if environ is None else environ
    key = config["environment"]
    selected = (env[key] if key in env else
                config.get("platformDefaults", {}).get(platform, config.get("default")))
    if not _native_absolute(selected, platform):
        raise ValueError(f"Invalid absolute {platform} root for {key}")
    return selected


def validate_relative_document_path(raw):
    """Paths in document aliases are root-relative POSIX form on every OS."""
    if (not isinstance(raw, str) or not raw or raw.startswith("/")
            or "\\" in raw or ":" in raw or "\x00" in raw
            or raw.startswith("./") or raw.endswith("/")
            or posixpath.normpath(raw) != raw
            or any(piece in ("", ".", "..") for piece in raw.split("/"))):
        raise ValueError(f"Unsafe relative context document path: {raw!r}")
    return raw


def validate_applies_to_pattern(raw):
    """Globs are document-root-relative; they may not escape that root."""
    if (not isinstance(raw, str) or not raw or raw.startswith("/")
            or "\\" in raw or ":" in raw or "\x00" in raw
            or raw.startswith("./") or raw.endswith("/")
            or posixpath.normpath(raw) != raw
            or any(piece in ("", ".", "..") for piece in raw.split("/"))):
        raise ValueError(f"Unsafe context applies_to glob: {raw!r}")
    return raw


def read_frontmatter(path, frontmatter_schema):
    """Read an entire owning README and schema-check only its YAML header."""
    body = Path(path).read_text(encoding="utf-8")
    if not body.startswith("---\n") or "\n---\n" not in body[4:]:
        raise ValueError(f"Missing context frontmatter: {path}")
    header, remainder = body[4:].split("\n---\n", 1)
    data = load_unique_yaml(header)
    _check_schema(data, frontmatter_schema, str(path))
    if not remainder.strip():
        raise ValueError(f"Empty context README: {path}")
    context = data["context"]
    if not context["title"].strip():
        raise ValueError(f"Blank context title: {path}")
    for value in context["applies_to"]:
        validate_applies_to_pattern(value)
    return context


def validate_context_contract(repo_root, manifest=None):
    """Validate canonical manifest and every Git-readable ownership document.

    Optional external host docs have reviewed Git README sources; they do not
    need to be installed to validate these definitions. This is not a resolver.
    """
    base = Path(repo_root).resolve()
    templates = base / "templates/context"
    # Even the manifest and schemas must not be provided through symlinks.
    for name in (".agents/context.yaml", "templates/context/context-manifest.schema.json",
                 "templates/context/context-frontmatter.schema.json"):
        require_context_source(base / name, base, name)
    manifest_schema = json.loads(
        (templates / "context-manifest.schema.json").read_text(encoding="utf-8")
    )
    frontmatter_schema = json.loads(
        (templates / "context-frontmatter.schema.json").read_text(encoding="utf-8")
    )
    Draft202012Validator.check_schema(manifest_schema)
    Draft202012Validator.check_schema(frontmatter_schema)
    if manifest is None:
        manifest = load_unique_yaml((base / ".agents/context.yaml").read_text(encoding="utf-8"))
    _check_schema(manifest, manifest_schema, ".agents/context.yaml")

    roots = manifest["roots"]
    documents = manifest["documents"]
    for alias, root in roots.items():
        if alias == "repo":
            continue
        if "default" in root and not (
                _native_absolute(root["default"], "linux")
                or _native_absolute(root["default"], "win32")):
            raise ValueError(f"Host root {alias}: default must be an absolute path")
        for platform, path in root.get("platformDefaults", {}).items():
            if not _native_absolute(path, platform):
                raise ValueError(f"Host root {alias}: invalid {platform} override")
    for entry, doc_id in manifest["entrypoints"].items():
        if doc_id not in documents:
            raise ValueError(f"Unknown context entrypoint {entry}: {doc_id}")

    graph = {}
    for doc_id, locator in documents.items():
        root, path = locator["root"], validate_relative_document_path(locator["path"])
        if root not in roots:
            raise ValueError(f"Unknown context document root: {doc_id} -> {root}")
        if root == "repo":
            target = base / path
            resolved = target.resolve()
            if not resolved.is_relative_to(base) or not target.is_file():
                raise ValueError(f"Missing or escaping repository context document: {doc_id}")
            reject_symlink_components(target, f"repository README {doc_id}")
        elif doc_id in HOST_SOURCE_DOCS:
            # The three reviewed host README sources are fixed counterparts
            # of their manifest aliases, not arbitrary host paths.
            if root != HOST_DOCUMENT_ROOTS[doc_id] or path != "README.md":
                raise ValueError(f"Host source-backed context alias mismatch: {doc_id}")
            target = require_context_source(
                base / HOST_SOURCE_DOCS[doc_id], base, doc_id
            )
        else:
            # Other optional host-only documents need not exist at schema time.
            if roots[root]["required"]:
                raise ValueError(f"Required host context document has no Git source: {doc_id}")
            continue
        context = read_frontmatter(target, frontmatter_schema)
        if context["id"] != doc_id:
            raise ValueError(f"Context README ID mismatch for {doc_id}")
        requires = context["requires"]
        if doc_id in requires:
            raise ValueError(f"Self-referential context dependency: {doc_id}")
        for dependency in requires:
            if dependency not in documents:
                raise ValueError(f"Unrecognized context dependency {doc_id} -> {dependency}")
        graph[doc_id] = requires

    visited, visiting = set(), set()

    def check_cycle(doc_id):
        if doc_id in visiting:
            raise ValueError(f"Context dependency cycle at {doc_id}")
        if doc_id in visited:
            return
        visiting.add(doc_id)
        for dependency in graph.get(doc_id, []):
            if dependency in graph:
                check_cycle(dependency)
        visiting.remove(doc_id)
        visited.add(doc_id)

    for doc_id in sorted(graph):
        check_cycle(doc_id)

    return {"manifest": manifest, "validatedDocumentIds": sorted(graph)}
