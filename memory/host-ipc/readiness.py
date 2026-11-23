"""Read-only M14 production prerequisite audit. No migrations, token calls or restart."""
import json
import os
import re
import pathlib
import stat
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = "/var/lib/bridge-memory-authority"
CODE = "/var/lib/bridge-memory-authority-code"
RUNTIME = "/var/lib/bridge-memory-authority-runtime/bin/python"
CLIENT = "/etc/agent-bridge/verified-memory-host.mjs"
SOCK = "/run/bridge-memory-authority/bridge.sock"
MANIFEST = ROOT + "/activation.json"
ACCEPTANCE = ROOT + "/m14-acceptance.json"


def protected_file(filename, mode=None):
    try:
        node = pathlib.Path(filename)
        st = node.lstat()
        if st.st_uid != 0 or not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
            return False
        if mode is not None and stat.S_IMODE(st.st_mode) != mode:
            return False
        for directory in node.parents:
            st = directory.lstat()
            if st.st_uid != 0 or not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o022:
                return False
        return True
    except (OSError, ValueError):
        return False


def protected_dir(filename):
    try:
        node = pathlib.Path(filename)
        for directory in [node, *node.parents]:
            st = directory.lstat()
            if st.st_uid != 0 or not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o022:
                return False
        return True
    except (OSError, ValueError):
        return False



def protected_executable(filename):
    try:
        candidate = filename
        visited = set()
        for _ in range(40):
            if not os.path.isabs(candidate) or candidate in visited:
                return False
            visited.add(candidate)
            node = pathlib.Path(candidate)
            if not all(d.lstat().st_uid == 0 and stat.S_ISDIR(d.lstat().st_mode)
                       and not d.lstat().st_mode & 0o022 for d in node.parents):
                return False
            st = node.lstat()
            if st.st_uid != 0:
                return False
            if stat.S_ISLNK(st.st_mode):
                target = os.readlink(candidate)
                if any(part in (".", "..") for part in target.split("/")):
                    return False
                candidate = os.path.normpath(os.path.join(os.path.dirname(candidate), target))
                continue
            return stat.S_ISREG(st.st_mode) and not st.st_mode & 0o022
        return False
    except (OSError, ValueError):
        return False


def read_activation():
    if not protected_file(MANIFEST, 0o600):
        return None
    try:
        fd = os.open(MANIFEST, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            data = os.read(fd, 16385)
        finally:
            os.close(fd)
        if not 0 < len(data) <= 16384:
            return None
        obj = json.loads(data)
        if (obj.get("schemaVersion") != 1 or obj.get("activation") is not True or
           not re.fullmatch(r"[a-f0-9]{40}", obj.get("releaseSha", ""))):
            return None
        return obj
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def release_matches(manifest, run=subprocess.run):
    if not manifest or not protected_dir(CODE):
        return False
    entry = manifest.get("bridge", {}).get("entrypoint")
    if not isinstance(entry, str) or not entry.startswith("/var/lib/bridge-runtime/") or not protected_file(entry):
        return False
    try:
        r = run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=CODE,
                env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent",
                     "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                     "GIT_NO_REPLACE_OBJECTS": "1"},
                capture_output=True, text=True, timeout=3)
        return r.returncode == 0 and r.stdout.strip() == manifest["releaseSha"]
    except (OSError, subprocess.TimeoutExpired):
        return False


def accepted_canary(manifest):
    if not manifest or not protected_file(ACCEPTANCE, 0o600):
        return False
    try:
        fd = os.open(ACCEPTANCE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            raw = os.read(fd, 4097)
        finally:
            os.close(fd)
        if not 0 < len(raw) <= 4096:
            return False
        record = json.loads(raw)
        required = ["livePromotion", "newSessionRecall", "foreignScopeDenied",
                    "duplicateDenied", "localEmbedding", "rollbackTested", "serviceIdentity"]
        return (type(record) is dict and record.get("schemaVersion") == 1 and
            record.get("accepted") is True and record.get("releaseSha") == manifest["releaseSha"]
            and all(record.get(key) is True for key in required))
    except (OSError, ValueError, AttributeError, TypeError):
        return False

def cluster_state(run):
    query = """
    SELECT (SELECT count(*)=2 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
        AND pg_get_userbyid(c.relowner) <> 'bridge')
        FROM pg_class c WHERE c.oid IN ('memu.recall_files'::regclass,
            'memu.recall_file_segments'::regclass)),
      (SELECT count(*)=2 FROM pg_roles WHERE rolname IN
        ('bridge_memory_reader','bridge_memory_writer')),
      (SELECT count(*) FROM bridge_memory_auth.scope_login)>0;
    """
    try:
        result = run(["/usr/sbin/runuser", "-u", "postgres", "--",
                      "/usr/lib/postgresql/18/bin/psql", "-X", "-qAt", "-v",
                      "ON_ERROR_STOP=1", "-d", "agent_memory", "-c", query],
                     timeout=5)
        return result.stdout.strip() == "t|t|t" if result.returncode == 0 else False
    except (OSError, subprocess.TimeoutExpired):
        return False


def systemd_unit_exists():
    try:
        result = subprocess.run(["/usr/bin/systemctl", "show", "--value", "-p",
                                 "FragmentPath", "verified-memory-authority.service"],
                                 capture_output=True, text=True, timeout=3)
        return result.returncode == 0 and result.stdout.strip().startswith("/etc/systemd/system/")
    except (OSError, subprocess.TimeoutExpired):
        return False


def audit(run=subprocess.run):
    manifest = read_activation()
    checks = {
        "rootAuthorityState": protected_dir(ROOT),
        "reviewedAuthorityCheckout": protected_dir(CODE),
        "sealedPythonRuntime": protected_executable(RUNTIME),
        "protectedBridgeClient": protected_file(CLIENT),
        "protectedSocket": False,
        "scopedPostgresRlsAndRoles": cluster_state(
            lambda *a, **kw: run(*a, capture_output=True, text=True, **kw)),
        "rootServiceUnitInstalled": systemd_unit_exists(),
        "operatorActivationManifest": manifest is not None,
        "trustedBridgeRelease": release_matches(manifest, run),
        "controlledLiveCanary": accepted_canary(manifest),
    }
    try:
        st = pathlib.Path(SOCK).lstat()
        checks["protectedSocket"] = stat.S_ISSOCK(st.st_mode) and st.st_uid == 0 and (
            stat.S_IMODE(st.st_mode) & 0o007) == 0
    except OSError:
        pass
    # The manifest alone never authorizes activation. The independent operator
    # acceptance record must describe the exact approved release and all
    # required actual canary observations; this audit never writes that record.
    return {"m14Ready": all(checks.values()), "checks": checks,
            "missing": [key for key, passed in checks.items() if not passed]}


def main():
    result = audit()
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    if "--strict" in sys.argv and not result["m14Ready"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
