#!/usr/bin/env python3
"""Read-only local ABR-17 host evidence. Never enables a service or reads keys."""
import argparse
import json
import os
import pathlib
import pwd
import stat
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
BINDING = pathlib.Path("/etc/agent-bridge/managed-submission-host.mjs")
SERVICE = "agent-bridge.service"


def run(args, timeout=8):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        return p.returncode, p.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def property_value(key):
    rc, value = run(["/usr/bin/systemctl", "show", SERVICE,
                     "--property=" + key, "--value"])
    return value if rc == 0 else None


def trusted_binding_present():
    for file in (BINDING, *BINDING.parents):
        try:
            s = file.lstat()
        except OSError:
            return False
        if s.st_uid != 0 or s.st_mode & 0o022 or stat.S_ISLNK(s.st_mode):
            return False
        if file == BINDING and not stat.S_ISREG(s.st_mode):
            return False
        if file != BINDING and not stat.S_ISDIR(s.st_mode):
            return False
    return True


def running_release(pid, proc_root=pathlib.Path("/proc")):
    """Identify the exact Node entrypoint of the active systemd MainPID."""
    if not pid or not pid.isdecimal() or int(pid) < 1:
        return None
    try:
        argv = (proc_root / pid / "cmdline").read_bytes().split(b"\0")
        entry = pathlib.Path(argv[1].decode("utf-8"))
        if not entry.is_absolute() or entry.name != "agent-bridge.mjs":
            return None
        release = entry.resolve(strict=True).parent.parent
        if not (release / ".git").is_dir():
            return None
        return release
    except (OSError, UnicodeError, IndexError, ValueError):
        return None


def service_path(pid, proc_root=pathlib.Path("/proc")):
    if not pid or not pid.isdecimal() or int(pid) < 1:
        return ""
    try:
        values = (proc_root / pid / "environ").read_bytes().split(b"\0")
        matches = [v[5:] for v in values if v.startswith(b"PATH=")]
        # Missing or duplicate PATH values are ambiguous; never select one
        # and accidentally claim a native launcher is discoverable.
        return matches[-1].decode("utf-8") if len(matches) == 1 else ""
    except (OSError, UnicodeError):
        return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=pathlib.Path,
                        help="Explicit installed Node binary, not a version-manager shim")
    args = parser.parse_args()
    user = property_value("User")
    uid = None
    try:
        uid = pwd.getpwnam(user).pw_uid if user == "bridge" else None
    except KeyError:
        pass
    state = property_value("ActiveState")
    pid = property_value("MainPID")
    release = running_release(pid) if state == "active" else None
    # Always measure the running, root-owned sealed release. A development
    # checkout or dirty user-owned worktree is not the activated service.
    head_rc, head = run(["/usr/bin/git", "-c", "safe.directory=" + str(release),
                        "-C", str(release), "rev-parse", "HEAD"]) if release else (1, "")
    status_rc, dirty = run(["/usr/bin/git", "-c", "safe.directory=" + str(release),
                            "-C", str(release), "status", "--porcelain",
                            "--untracked-files=no"]) if release else (1, "")
    result = {"schemaVersion": 1, "mode": "read_only_host_probe",
              "releasePath": str(release) if release else None,
              "commit": head if head_rc == 0 and len(head) == 40 else None,
              "trackedClean": status_rc == 0 and not dirty, "serviceState": state,
              "serviceUid": uid, "protectedBindingPresent": trusted_binding_present(),
              "rootlessSandbox": "unverified", "nativeDiscovery": {},
              "bubblewrapPolicyState": run(["/usr/bin/systemctl", "is-active",
                   "agent-bridge-bwrap-policy.service"])[1] or "unknown",
              "actualNativeSubmission": "unverified",
              "liveProviderIdentityAndPermissions": "unverified",
              "livePublication": "unverified", "macTransport": "unverified",
              "deploymentAuthorized": False, "releaseReady": False}
    if uid and (os.getuid() == uid or os.getuid() == 0):
        prefix = [] if os.getuid() == uid else ["/usr/sbin/runuser", "-u", user, "--"]
        node = args.node
        if node is None and pid and pid.isdecimal() and int(pid) > 0:
            try:
                node = pathlib.Path("/proc") / pid / "exe"
                node = node.resolve(strict=True)
            except OSError:
                node = None
        # Avoid the shim and inherited HOME: they may resolve the wrong
        # user's Node or recurse. Require the actual installed executable.
        if node is not None:
            try:
                node = node.resolve(strict=True)
                if not node.is_file() or not os.access(node, os.X_OK):
                    node = None
            except OSError:
                node = None
        # Run the existing exact probe under the service UID, not root.
        rc, stdout = run(prefix + ["/usr/bin/env", "-i",
                              "HOME=" + pwd.getpwnam(user).pw_dir,
                              "PATH=/usr/bin:/bin", "LANG=C",
                              str(node), str(release / "scripts/mcp-executor-probe.mjs"), "--strict"]) if node and release else (1, "")
        try:
            probe = json.loads(stdout)
            if probe.get("uid") == uid:
                result["rootlessSandbox"] = "pass" if rc == 0 and probe.get("available") is True else "blocked"
                # Never copy untrusted raw stderr into the report.
                if result["rootlessSandbox"] == "blocked":
                    result["sandboxFailure"] = "namespace_permission_denied" if "Permission denied" in str(probe.get("error")) else "probe_failed"
        except ValueError:
            pass
        # Test the PATH inherited by the running service rather than a
        # hard-coded, historic user-home PATH. Native binaries are configured
        # by absolute path elsewhere; discovery is observational only.
        runtime_path = service_path(pid)
        for name in ("agy", "trae-cli", "opencode"):
            rc, _ = run(prefix + ["/usr/bin/env", "-i",
                "HOME=" + pwd.getpwnam(user).pw_dir,
                "PATH=" + runtime_path, "LANG=C",
                "/bin/sh", "-c", 'command -v "$1" >/dev/null', "probe", name])
            result["nativeDiscovery"][name] = (
                "found" if runtime_path and rc == 0 else "not_on_service_path")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 2  # This probe cannot grant release approval.


if __name__ == "__main__":
    raise SystemExit(main())
