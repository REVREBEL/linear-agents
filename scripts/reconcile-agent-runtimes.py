#!/usr/bin/env python3
"""Reconcile the non-dispatching Ubuntu CLI inventory from a reviewed Git source.

This manifest inventories CLI harness installations, not Linear agent identities.
It is never imported by the live Bridge routing/admission/dispatch code.
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

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "templates/context/agent-runtimes.staged.json"
DEFAULT_TARGET = Path("/opt/agents/registry/agent-runtimes.json")
HARNESS_NAMES = {"opencode", "gemini", "kilo", "codex"}
EXPECTED_KEYS = {
    "schemaVersion", "status", "launcher", "defaultNodeHome",
    "agentIdentity", "agents",
}
ENTRY_KEYS = {
    "command", "home", "kind", "invocation", "enabledForDispatch",
}


def fail(message):
    raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def ensure_absolute_child(value, root):
    if not isinstance(value, str) or not value.startswith(root + "/"):
        fail(f"Expected an absolute path beneath {root}: {value!r}")
    if ".." in Path(value).parts:
        fail(f"Path traversal is not allowed: {value!r}")


def validate(source):
    if set(source) != EXPECTED_KEYS:
        fail(f"Unexpected inventory keys: {sorted(set(source) ^ EXPECTED_KEYS)}")
    if source["schemaVersion"] != 1 or source["status"] != "staged-not-integrated":
        fail("Only schema v1 staged-not-integrated inventories are supported")
    if source["launcher"] != "/opt/agent-tools/bin/agent-exec":
        fail("Launcher path is not the reviewed agent-exec wrapper")
    if source["defaultNodeHome"] != "/opt/global-tools/volta":
        fail("Node home must use the approved /opt/global-tools/volta root")
    if source["agentIdentity"] != "bridge":
        fail("Host agent identity must be explicitly set to bridge")
    if not isinstance(source["agents"], dict) or set(source["agents"]) != HARNESS_NAMES:
        fail("Runtime inventory must list exactly the four reviewed harnesses")
    for name, entry in source["agents"].items():
        if not isinstance(entry, dict) or set(entry) - (ENTRY_KEYS | {"service"}):
            fail(f"{name}: unknown inventory attributes")
        if not ENTRY_KEYS.issubset(entry):
            fail(f"{name}: missing required inventory attributes")
        if entry["home"] != f"/opt/agents/{name}":
            fail(f"{name}: invalid agent-specific home")
        if entry["invocation"] != "requires-adapter":
            fail(f"{name}: cannot infer executable adapter readiness")
        if entry["enabledForDispatch"] is not False:
            fail(f"{name}: never enable dispatch through host inventory")
        if name == "opencode":
            if entry["kind"] != "native" or entry["command"] != "/opt/agent-tools/bin/opencode":
                fail("OpenCode must use its reviewed native executable")
            if entry.get("service") != "opencode-central.service":
                fail("Keep the existing OpenCode service name as passive metadata")
        else:
            if entry["kind"] != "volta" or entry.get("service") is not None:
                fail(f"{name}: expected Volta-installed CLI without service registration")
            if entry["command"] != f"/opt/global-tools/volta/bin/{name}":
                fail(f"{name}: CLI must point at approved Volta shim")
        ensure_absolute_child(entry["command"], "/opt")


def changed_fields(current, expected, prefix=""):
    if isinstance(current, dict) and isinstance(expected, dict):
        for key in sorted(set(current) | set(expected)):
            yield from changed_fields(current.get(key), expected.get(key), f"{prefix}.{key}" if prefix else key)
    elif current != expected:
        yield prefix


def check(target, desired):
    if not target.exists() or target.is_symlink():
        fail(f"Expected a regular staged inventory file: {target}")
    existing = read_json(target)
    differences = list(changed_fields(existing, desired))
    if differences:
        print(f"Drift from reviewed Git source: {target}", file=sys.stderr)
        for field in differences:
            print(f"  {field}", file=sys.stderr)
        return 1
    print(f"Staged inventory matches reviewed Git source: {target}")
    return 0


def install(target, desired):
    if not target.exists() or target.is_symlink() or not target.is_file():
        fail(f"Refusing to replace missing or non-regular target: {target}")
    old = read_json(target)
    if old.get("schemaVersion") != 1 or old.get("status") != "staged-not-integrated":
        fail("Refusing to replace an active, unknown, or differently versioned registry")
    if any(not isinstance(x, dict) or x.get("enabledForDispatch") is not False
           for x in old.get("agents", {}).values()):
        fail("Refusing overwrite: installed inventory contains enabled dispatch entries")
    if old == desired:
        print(f"Already synchronized: {target}")
        return 0
    metadata = target.stat()
    backup = target.with_name(f"{target.name}.backup-{time.time_ns()}")
    shutil.copy2(target, backup)
    encoded = (json.dumps(desired, indent=2) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        temporary_metadata = os.stat(temporary)
        if (temporary_metadata.st_uid, temporary_metadata.st_gid) != (metadata.st_uid, metadata.st_gid):
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        temporary_metadata = os.stat(temporary)
        if (temporary_metadata.st_uid, temporary_metadata.st_gid) != (metadata.st_uid, metadata.st_gid):
            fail("Cannot preserve target ownership; run with authorized host file permissions")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"Updated staged inventory: {target}")
    print(f"Previous inventory backup: {backup}")
    return 0


def probe(desired):
    """Inspect path existence only. This is not readiness or dispatch authorization."""
    paths = [("launcher", desired["launcher"]), ("node-home", desired["defaultNodeHome"])]
    for name, item in desired["agents"].items():
        paths.extend(((f"{name}.home", item["home"]), (f"{name}.command", item["command"])))
    missing = 0
    for label, path in paths:
        ok = os.path.isdir(path) if label.endswith(".home") or label == "node-home" else os.path.isfile(path) and os.access(path, os.X_OK)
        print(f"{label}: {'present' if ok else 'missing'} ({path})")
        if not ok:
            missing += 1
    print("Probe checks paths only: services, authentication and adapters are NOT verified.")
    return 1 if missing else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="Compare host file with the reviewed Git snapshot (default)")
    group.add_argument("--render", action="store_true", help="Print the reviewed JSON snapshot")
    group.add_argument("--validate", action="store_true", help="Validate the Git source alone")
    group.add_argument("--probe", action="store_true", help="Read-only executable/home path probe")
    group.add_argument("--apply", action="store_true", help="Back up and atomically update staged host JSON")
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET,
                        help="Host snapshot target (default: /opt/agents/registry/agent-runtimes.json)")
    args = parser.parse_args()
    desired = read_json(SOURCE)
    validate(desired)
    if args.render:
        print(json.dumps(desired, indent=2))
        return 0
    if args.validate:
        print(f"Reviewed disabled-only source is valid: {SOURCE}")
        return 0
    if args.probe:
        return probe(desired)
    if args.apply:
        return install(args.target, desired)
    return check(args.target, desired)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"agent-runtimes reconciliation failed: {error}", file=sys.stderr)
        sys.exit(2)
