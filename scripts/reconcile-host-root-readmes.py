#!/usr/bin/env python3
"""Validate, compare, or explicitly install the three reviewed /opt root READMEs.

The installed files are documentation only. No agent execution, host settings,
authentication, services or toolchain files are modified.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import time

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "templates/context/host-roots"
DEFAULT_HOST_ROOT = Path("/opt")
DOCS = {
    "agents": "host.agent-runtimes",
    "agent-tools": "host.agent-tools",
    "global-tools": "host.global-tools",
}


def fail(message):
    raise ValueError(message)


def reviewed_sources():
    """Load and schema-check Git sources without accessing host-private state."""
    manifest = yaml.safe_load((ROOT / ".agents/context.yaml").read_text(encoding="utf-8"))
    schema = json.loads(
        (ROOT / "templates/context/context-frontmatter.schema.json").read_text(encoding="utf-8")
    )
    Draft202012Validator.check_schema(schema)
    sources = {}
    for folder, doc_id in DOCS.items():
        source = SOURCE_ROOT / folder / "README.md"
        if source.is_symlink() or not source.is_file():
            fail(f"Missing or unsafe reviewed source: {source}")
        content = source.read_text(encoding="utf-8")
        marker = f"<!-- Managed source: templates/context/host-roots/{folder}/README.md -->"
        if not content.startswith("---\n") or "\n---\n" not in content[4:] or marker not in content:
            fail(f"Missing frontmatter or management marker: {source}")
        context = yaml.safe_load(content[4:].split("\n---\n", 1)[0])
        Draft202012Validator(schema).validate(context)
        if context["context"]["id"] != doc_id:
            fail(f"Incorrect context ID in {source}")
        for dep in context["context"]["requires"]:
            if dep == doc_id or dep not in manifest["documents"]:
                fail(f"Unknown or self-referential dependency in {source}: {dep}")
        locator = manifest["documents"].get(doc_id)
        expected_root = "host-" + folder
        if locator != {"root": expected_root, "path": "README.md"}:
            fail(f"Host document alias mismatch: {doc_id}")
        sources[folder] = content.encode("utf-8")
    return sources


def destinations(root):
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        fail(f"Expected an existing real host parent directory: {root}")
    targets = {}
    for folder in DOCS:
        parent = root / folder
        if parent.is_symlink() or not parent.is_dir():
            fail(f"Expected a real existing host root: {parent}")
        target = parent / "README.md"
        if target.is_symlink() or (target.exists() and not target.is_file()):
            fail(f"Refusing non-regular or symlink README: {target}")
        targets[folder] = target
    return targets


def check_host(root, sources):
    different = 0
    for folder, target in destinations(root).items():
        expected = sources[folder]
        if not target.exists():
            print(f"MISSING: {target}")
            different += 1
        elif target.read_bytes() != expected:
            print(f"DRIFT: {target}")
            different += 1
        else:
            print(f"MATCH: {target}")
    return 1 if different else 0


def install_host(root, sources):
    targets = destinations(root)
    # Preflight all three targets before mutating any file.
    for folder, target in targets.items():
        if target.exists():
            old = target.read_bytes()
            marker = f"<!-- Managed source: templates/context/host-roots/{folder}/README.md -->".encode()
            if marker not in old:
                fail(f"Refusing to overwrite an unmanaged host README: {target}")
    for folder, target in targets.items():
        expected = sources[folder]
        if target.exists() and target.read_bytes() == expected:
            print(f"UNCHANGED: {target}")
            continue
        previous = target.stat() if target.exists() else None
        fd, name = tempfile.mkstemp(dir=target.parent, prefix=".README.")
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(expected)
                stream.flush()
                os.fsync(stream.fileno())
            if previous:
                staging = os.stat(name)
                if (staging.st_uid, staging.st_gid) != (previous.st_uid, previous.st_gid):
                    os.chown(name, previous.st_uid, previous.st_gid)
                os.chmod(name, stat.S_IMODE(previous.st_mode))
                backup = target.with_name(f"README.md.backup-{time.time_ns()}")
                shutil.copy2(target, backup)
            else:
                os.chmod(name, 0o644)
            os.replace(name, target)
            print(f"INSTALLED: {target}")
            if previous:
                print(f"BACKUP: {backup}")
        finally:
            if os.path.exists(name):
                os.unlink(name)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--validate", action="store_true", help="Validate Git sources only")
    mode.add_argument("--check", action="store_true", help="Compare host READMEs without changes")
    mode.add_argument("--apply", action="store_true", help="Install reviewed Git READMEs on /opt")
    args = parser.parse_args()
    sources = reviewed_sources()
    if args.validate:
        print("Validated three reviewed host-root README sources and context IDs")
        return 0
    if args.check:
        return check_host(DEFAULT_HOST_ROOT, sources)
    return install_host(DEFAULT_HOST_ROOT, sources)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, yaml.YAMLError, json.JSONDecodeError) as exc:
        print(f"host root README reconciliation failed: {exc}", file=sys.stderr)
        sys.exit(2)
