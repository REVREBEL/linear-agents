#!/usr/bin/env python3
"""Build, verify and explicitly install the reviewed Agent Context CLI zipapp.

The single-file Python zipapp is portable and contains only committed source
modules. Third-party PyYAML/jsonschema dependencies are provided by the host.
No Bridge service, credentials, runtime profile or agent identity is touched.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = Path("/opt/agent-tools/bin/agent-context")
SOURCES = {
    "agent_context_cli.py": "scripts/agent_context_cli.py",
    "context_contract.py": "scripts/context_contract.py",
}
SHEBANG = b"#!/usr/bin/env python3\n"
ENTRYPOINT = b"from agent_context_cli import main\nraise SystemExit(main())\n"
MANIFEST = "__build__.json"
PRODUCER = "revrebel-agent-context-c2"
ARCHIVE_FILES = frozenset((*SOURCES, "__main__.py", MANIFEST))


def refuse(message):
    raise ValueError(message)


def git(*args):
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True,
    ).stdout


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def validated_sources():
    """Read committed Git blobs and fail on working-tree drift, regardless of flags."""
    sources = {}
    for archive_name, repo_path in SOURCES.items():
        path = ROOT / repo_path
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT.resolve()):
            refuse(f"Missing or unsafe CLI source file: {repo_path}")
        committed = git("show", f"HEAD:{repo_path}")
        if path.read_bytes() != committed:
            refuse(f"CLI source differs from committed Git blob: {repo_path}")
        sources[archive_name] = committed
    commit = git(
        "log", "-1", "--format=%H", "--", *SOURCES.values()
    ).decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        refuse("No valid Git commit provenance for CLI source modules")
    return sources, build_metadata(sources, commit)


def build_metadata(sources, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        refuse("Invalid CLI source commit")
    if set(sources) != set(SOURCES):
        refuse("Missing or unexpected CLI source module")
    return {
        "formatVersion": 1,
        "producer": PRODUCER,
        "sourceCommit": commit,
        "sources": {name: sha256(sources[name]) for name in sorted(sources)},
    }


def manifest_bytes(metadata):
    return (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode("utf-8")


def archive_bytes(sources, metadata):
    """Build deterministic zipapp bytes; no filesystem timestamps or user paths."""
    if build_metadata(sources, metadata.get("sourceCommit", "")) != metadata:
        refuse("Invalid or mismatched CLI build metadata")
    members = {
        "__main__.py": ENTRYPOINT,
        MANIFEST: manifest_bytes(metadata),
        **sources,
    }
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, members[name])
    return SHEBANG + stream.getvalue()


def inspect_managed(target):
    """Refuse any edited or unrelated executable; recognize older managed builds."""
    if target.is_symlink() or (target.exists() and not target.is_file()):
        refuse(f"Unsafe agent-context executable target: {target}")
    if not target.exists():
        return None
    data = target.read_bytes()
    if not data.startswith(SHEBANG):
        refuse(f"Unmanaged executable (invalid shebang): {target}")
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            if set(archive.namelist()) != ARCHIVE_FILES:
                refuse(f"Unmanaged executable (unexpected archive files): {target}")
            metadata = json.loads(archive.read(MANIFEST).decode("utf-8"))
            sources = {name: archive.read(name) for name in SOURCES}
            if archive.read("__main__.py") != ENTRYPOINT:
                refuse(f"Unmanaged executable entrypoint: {target}")
        if build_metadata(sources, metadata.get("sourceCommit", "")) != metadata:
            refuse(f"Managed CLI source/metadata digest mismatch: {target}")
        if archive_bytes(sources, metadata) != data:
            refuse(f"Modified managed CLI executable: {target}")
    except (zipfile.BadZipFile, KeyError, UnicodeError, json.JSONDecodeError, TypeError) as error:
        refuse(f"Unmanaged or corrupted CLI executable: {target}: {error}")
    return data


def check_install(target, desired):
    installed = inspect_managed(target)
    if installed is None:
        print(f"MISSING: {target}")
        return 1
    if installed != desired:
        print(f"OUTDATED: {target} (reviewed source changed)")
        return 1
    print(f"MATCH: {target} ({sha256(desired)[:12]})")
    return 0


def install(target, desired):
    """Atomically replace only the one reviewed CLI binary; retain prior version."""
    parent = target.parent
    if parent.is_symlink() or not parent.is_dir():
        refuse(f"CLI executable parent must be an existing real directory: {parent}")
    installed = inspect_managed(target)
    if installed == desired:
        print(f"UNCHANGED: {target}")
        return 0
    backup = None
    if installed is not None:
        backup = target.with_name(f"agent-context.backup-{time.time_ns()}")
        if backup.exists():
            refuse(f"Backup path already exists: {backup}")
        shutil.copy2(target, backup)
    fd, staged = tempfile.mkstemp(dir=parent, prefix=".agent-context.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(desired)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(staged, 0o755)
        os.replace(staged, target)
        print(f"INSTALLED: {target} ({sha256(desired)[:12]})")
        if backup is not None:
            print(f"PREVIOUS VERSION: {backup}")
        return 0
    finally:
        if os.path.exists(staged):
            os.unlink(staged)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--validate", action="store_true", help="Validate reviewed Git source and build portable zipapp")
    action.add_argument("--check", action="store_true", help="Read-only comparison to installed Ubuntu executable")
    action.add_argument("--apply", action="store_true", help="Explicitly install executable from approved source")
    args = parser.parse_args()
    sources, meta = validated_sources()
    artifact = archive_bytes(sources, meta)
    if args.validate:
        print(f"Validated Agent Context C2 zipapp: {len(sources)} source modules, "
              f"commit {meta['sourceCommit'][:12]}, SHA-256 {sha256(artifact)[:12]}")
        return 0
    if args.check:
        return check_install(TARGET, artifact)
    return install(TARGET, artifact)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Agent Context CLI install failed: {error}", file=sys.stderr)
        sys.exit(2)
