#!/usr/bin/env python3
"""Publish the Git-reviewed context template set to /opt/agent-tools/templates/context.

--validate reads Git sources only; --check is read-only; --apply explicitly
installs an atomic directory snapshot. Never loads or changes native agent state.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "templates/context"
TARGET = Path("/opt/agent-tools/templates/context")
MANIFEST = ".managed-context.json"
SCHEMA_VERSION = 1
TYPES = {".md", ".json", ".yaml", ".yml"}
REQUIRED = {
    "README.md", "README.template.md", "host-root.README.template.md",
    "context-frontmatter.schema.json", "agent-profile.entry.schema.json",
    "agent-profile.v2.template.yaml", "bridge-runtime-registry.v2-entry.template.json",
    "profile-mapping.md", "host-roots/README.md",
    "host-roots/agents/README.md", "host-roots/agent-tools/README.md",
    "host-roots/global-tools/README.md",
}


def refuse(message):
    raise ValueError(message)


def git(*args):
    result = subprocess.run(
        ["git", "-C", str(ROOT), *args],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return result.stdout


def normalize_file(path):
    if (not isinstance(path, str) or not path or path.startswith(".")
            or "\\" in path or "\x00" in path):
        refuse(f"Unsafe managed template path: {path!r}")
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts or "." in candidate.parts:
        refuse(f"Unsafe managed template path: {path!r}")
    if any(part.startswith(".") for part in candidate.parts):
        refuse(f"Hidden managed template file: {path!r}")
    if candidate.suffix.lower() not in TYPES:
        refuse(f"Unexpected template file extension: {path!r}")
    return candidate


def digest(content):
    return hashlib.sha256(content).hexdigest()


def snapshot(files, source_commit):
    """Deterministic manifest, never a provider registry or executable policy."""
    if not files or len(source_commit) != 40 or any(c not in "0123456789abcdef" for c in source_commit):
        refuse("Missing tracked files or invalid Git revision")
    descriptors = {}
    for name, data in sorted(files.items()):
        normalize_file(name)
        if name == MANIFEST or not isinstance(data, bytes):
            refuse("Invalid template snapshot entry")
        descriptors[name] = {"sha256": digest(data), "bytes": len(data)}
    tree_hash = digest("".join(
        f"{name}\0{meta['sha256']}\n" for name, meta in descriptors.items()
    ).encode("utf-8"))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "templateSet": "agent-context",
        "sourceRoot": "templates/context",
        "sourceCommit": source_commit,
        "sourceTreeSha256": tree_hash,
        "files": descriptors,
    }


def reviewed_sources():
    """Inspect exactly the tracked Git template files; refuse uncommitted edits."""
    if git("diff", "--name-only", "--", "templates/context").strip():
        refuse("Uncommitted changes to source templates")
    if git("diff", "--cached", "--name-only", "--", "templates/context").strip():
        refuse("Staged but uncommitted changes to source templates")
    listing = git("ls-files", "-z", "--", "templates/context").split(b"\0")
    files = {}
    for raw in filter(None, listing):
        tracked = raw.decode("utf-8")
        prefix = "templates/context/"
        if not tracked.startswith(prefix):
            refuse("Unrecognized Git source path")
        name = tracked[len(prefix):]
        rel = normalize_file(name)
        source = SOURCE_ROOT / rel
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(SOURCE_ROOT.resolve()):
            refuse(f"Unsafe source template: {name}")
        if name in files:
            refuse(f"Duplicate source template: {name}")
        files[name] = source.read_bytes()
    missing = REQUIRED - set(files)
    if missing:
        refuse(f"Required context source templates missing: {sorted(missing)}")
    commit = git("log", "-1", "--format=%H", "--", "templates/context").decode().strip()
    if not commit:
        refuse("Source template Git revision is not known")
    manifest = snapshot(files, commit)
    return files, manifest


def manifest_bytes(manifest):
    return (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")


def check_parent(target, create=False):
    """Check every managed path component, rejecting symlink escapes."""
    ancestor = target.parent.parent
    if ancestor.is_symlink() or not ancestor.is_dir():
        refuse(f"Missing or unsafe shared agent tools root: {ancestor}")
    parent = target.parent
    if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
        refuse(f"Unsafe managed template parent: {parent}")
    if not parent.exists() and create:
        parent.mkdir(mode=0o2775)
    return parent.exists()


def inspect_install(target):
    """Return installed manifest only if every managed byte is unmodified."""
    check_parent(target)
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        refuse(f"Unsafe managed template installation: {target}")
    if not target.exists():
        return None
    marker = target / MANIFEST
    if marker.is_symlink() or not marker.is_file():
        refuse(f"Unmanaged context directory (no publisher manifest): {target}")
    try:
        installed = json.loads(marker.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeError) as exc:
        refuse(f"Invalid installed template manifest: {exc}")
    if (not isinstance(installed, dict) or installed.get("schemaVersion") != SCHEMA_VERSION
            or installed.get("templateSet") != "agent-context"
            or installed.get("sourceRoot") != "templates/context"
            or not isinstance(installed.get("files"), dict)):
        refuse("Unrecognized installed context template manifest")
    listed = installed["files"]
    actual, actual_dirs = set(), set()
    for root, dirs, filenames in os.walk(target, followlinks=False):
        for folder in dirs:
            path = Path(root) / folder
            if path.is_symlink():
                refuse(f"Unsafe symlink directory: {path}")
            actual_dirs.add(path.relative_to(target).as_posix())
        for filename in filenames:
            path = Path(root) / filename
            if path.is_symlink() or not path.is_file():
                refuse(f"Unsafe managed file: {path}")
            actual.add(path.relative_to(target).as_posix())
    expected_files = set(listed) | {MANIFEST}
    expected_dirs = set()
    for name in listed:
        rel = normalize_file(name)
        for parent in rel.parents:
            if str(parent) != ".":
                expected_dirs.add(parent.as_posix())
    if actual != expected_files or actual_dirs != expected_dirs:
        refuse(f"Unmanaged or missing files/directories in {target}: "
               f"files={sorted(actual ^ expected_files)}, "
               f"directories={sorted(actual_dirs ^ expected_dirs)}")
    for name, meta in listed.items():
        normalize_file(name)
        path = target / name
        if not isinstance(meta, dict) or set(meta) != {"sha256", "bytes"}:
            refuse(f"Invalid installed hash descriptor: {name}")
        data = path.read_bytes()
        if len(data) != meta["bytes"] or digest(data) != meta["sha256"]:
            refuse(f"Modified managed context file; refusing overwrite: {path}")
    return installed


def check_install(target, expected):
    existing = inspect_install(target)
    if existing is None:
        print(f"MISSING: {target}")
        return 1
    if existing != expected:
        print(f"OUTDATED: {target} (reviewed source changed)")
        return 1
    print(f"MATCH: {target} ({expected['sourceTreeSha256'][:12]})")
    return 0


def exchange_directories(left, right):
    """Atomically swap two existing directories on Linux or fail closed."""
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        refuse("Atomic directory exchange requires Linux renameat2 support")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(left), str(right))


def publish(target, files, expected):
    """Atomically swap an intact managed directory, retaining old versions."""
    current = inspect_install(target)
    if current == expected:
        print(f"UNCHANGED: {target}")
        return 0
    # No deletion or overwrite of unknown files. Preflight happens before mkdir.
    check_parent(target, create=True)
    staging = Path(tempfile.mkdtemp(dir=target.parent, prefix=".context.staging-"))
    backup = None
    try:
        for name, data in sorted(files.items()):
            rel = normalize_file(name)
            file = staging / rel
            file.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            file.write_bytes(data)
            file.chmod(0o644)
        marker = staging / MANIFEST
        marker.write_bytes(manifest_bytes(expected))
        marker.chmod(0o644)
        staging.chmod(0o755)
        if current is not None:
            backup = target.with_name(f"context.backup-{time.time_ns()}")
            # The live path always points to a complete snapshot. After the
            # exchange staging contains the previous version; never delete it
            # if moving it to the backup name fails.
            exchange_directories(staging, target)
            old_snapshot = staging
            staging = None
            try:
                os.rename(old_snapshot, backup)
            except OSError as error:
                raise OSError(f"New snapshot installed; previous snapshot retained at {old_snapshot}: {error}") from error
        else:
            os.rename(staging, target)
            staging = None
        print(f"INSTALLED: {target} ({expected['sourceTreeSha256'][:12]})")
        if backup is not None:
            print(f"PREVIOUS VERSION: {backup}")
        return 0
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--validate", action="store_true", help="Validate tracked Git template sources")
    mode.add_argument("--check", action="store_true", help="Read-only comparison with /opt")
    mode.add_argument("--apply", action="store_true", help="Explicitly install reviewed templates on /opt")
    args = parser.parse_args()
    files, expected = reviewed_sources()
    if args.validate:
        print(f"Validated {len(files)} tracked context sources; revision {expected['sourceCommit'][:12]}; digest {expected['sourceTreeSha256'][:12]}")
        return 0
    if args.check:
        return check_install(TARGET, expected)
    return publish(TARGET, files, expected)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError, UnicodeError) as exc:
        print(f"context template publication failed: {exc}", file=sys.stderr)
        sys.exit(2)
