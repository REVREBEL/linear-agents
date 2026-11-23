"""Read-only M14 production prerequisite audit. No migrations, token calls or restart."""
import hashlib
import json
import os
import pwd
import re
import pathlib
import stat
import subprocess
import socket
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


def protected_dir(filename, mode=None):
    try:
        node = pathlib.Path(filename)
        for directory in [node, *node.parents]:
            st = directory.lstat()
            if st.st_uid != 0 or not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o022:
                return False
        return mode is None or stat.S_IMODE(node.lstat().st_mode) == mode
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
            return (stat.S_ISREG(st.st_mode) and not st.st_mode & 0o022
                    and bool(stat.S_IMODE(st.st_mode) & 0o100))
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


def reviewed_checkout(root, sha, run=subprocess.run):
    """Trust all executable dependencies and reject unreviewed worktree bytes."""
    if (not isinstance(root,str) or not isinstance(sha,str) or
        not re.fullmatch("[a-f0-9]{40}",sha) or not protected_dir(root)):
        return False
    count = 0
    try:
        for basedir, directories, files in os.walk(root,followlinks=False):
            for name in (*directories,*files):
                node = pathlib.Path(basedir)/name
                st = node.lstat()
                count += 1
                if (count>60000 or st.st_uid!=0 or st.st_mode & 0o022 or
                    not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode))):
                    return False
        if not count:
            return False
        args=[["rev-parse","HEAD"],
              ["rev-parse","--show-toplevel"],
              ["status","--porcelain=v1","--untracked-files=all"],
              ["ls-files","--others","--ignored","--exclude-standard"]]
        env={"PATH":"/usr/bin:/bin","HOME":"/nonexistent",
             "GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null",
             "GIT_NO_REPLACE_OBJECTS":"1","GIT_OPTIONAL_LOCKS":"0"}
        values=[]
        for argv in args:
            r=run(["/usr/bin/git",*argv],cwd=root,env=env,
                  capture_output=True,text=True,timeout=8)
            if r.returncode:
                return False
            values.append(r.stdout.strip())
        return values==[sha,root,"",""]
    except (OSError,ValueError,TypeError,subprocess.TimeoutExpired):
        return False


def release_matches(manifest, run=subprocess.run):
    if not manifest or not reviewed_checkout(CODE, manifest["releaseSha"]):
        return False
    bridge = manifest.get("bridge", {})
    entry = bridge.get("entrypoint")
    if not isinstance(entry, str) or not entry.startswith("/var/lib/bridge-runtime/"):
        return False
    if not protected_file(entry) or not reviewed_checkout("/var/lib/bridge-runtime",
                                                         bridge.get("releaseSha")):
        return False
    for source in manifest.get("sourceCheckouts", {}).values():
        if not isinstance(source, dict) or not reviewed_checkout(
              source.get("root"), source.get("headSha")):
            return False
    return True


def bridge_identity(manifest, run=subprocess.run):
    if not manifest:
        return False
    bridge = manifest.get("bridge", {})
    try:
        value = run(["/usr/bin/systemctl", "show", "--value", "-p", "MainPID",
                     "agent-bridge.service"], capture_output=True,text=True,timeout=3)
        if value.returncode != 0 or int(value.stdout.strip()) != bridge["pid"]:
            return False
        statline = pathlib.Path("/proc/%s/stat" % bridge["pid"]).read_text()
        actual = statline[statline.rfind(")") + 2:].split()[19]
        return actual == bridge.get("startTicks")
    except (OSError, ValueError, IndexError, TypeError, KeyError, subprocess.TimeoutExpired):
        return False


def client_readable():
    if not protected_file(CLIENT):
        return False
    try:
        st = pathlib.Path(CLIENT).lstat()
        user = pwd.getpwnam("bridge")
        return ((st.st_uid == user.pw_uid and bool(st.st_mode & 0o400)) or
                (st.st_gid == user.pw_gid and bool(st.st_mode & 0o040)) or
                bool(st.st_mode & 0o004))
    except (OSError, KeyError):
        return False


def socket_live(run=subprocess.run):
    try:
        user = pwd.getpwnam("bridge")
        node = pathlib.Path(SOCK)
        st = node.lstat()
        base = node.parent.lstat()
        if not (stat.S_ISSOCK(st.st_mode) and st.st_uid == 0 and
                st.st_gid == user.pw_gid and stat.S_IMODE(st.st_mode) == 0o660 and
                stat.S_ISDIR(base.st_mode) and base.st_uid == 0 and
                base.st_gid == user.pw_gid and stat.S_IMODE(base.st_mode) == 0o750):
            return False
        conn = socket.socket(socket.AF_UNIX)
        conn.settimeout(.25)
        try:
            conn.connect(SOCK)
            return True
        finally:
            conn.close()
    except (OSError, KeyError):
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

def scope_bindings(manifest):
    if not manifest or not isinstance(manifest.get("jobs"), list) or not manifest["jobs"]:
        return None
    bindings = {}
    for record in manifest["jobs"]:
        scope = record["trustedJob"]["scope"]
        user = hashlib.sha256(json.dumps([scope["tenantId"],
            scope["repositoryId"], scope["issueId"]],
            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        agent = scope["agentId"]
        suffix = hashlib.sha256(json.dumps([user, agent], ensure_ascii=False,
            separators=(",", ":")).encode()).hexdigest()[:56]
        roles = ("bmr_" + suffix,"bmw_" + suffix)
        bindings[roles] = dict(reader=roles[0],writer=roles[1],
                              user_id=user,agent_id=agent)
    return list(bindings.values())


def cluster_state(manifest, run, *, host="/var/run/postgresql",
                  port=5433, database="agent_memory"):
    bindings = scope_bindings(manifest)
    if not bindings:
        return False
    try:
        query = (HERE / "db-gate.sql").read_text()
        argv = ["/usr/sbin/runuser", "-u", "postgres", "--",
                "/usr/lib/postgresql/18/bin/psql", "-X", "-qAt",
                "-v", "ON_ERROR_STOP=1", "-v", "bindings=" + json.dumps(bindings),
                "-v", "expected_database=" + database,
                "-h",host,"-p",str(port),"-d",database,"-f","-"]
        result = run(argv, input=query, capture_output=True, text=True, timeout=8)
        return result.returncode == 0 and result.stdout.strip() == "t"
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, KeyError):
        return False


def systemd_unit_exists(run=subprocess.run):
    """Match the exact reviewed unit and effective sandbox, not any unit path."""
    deployed = "/etc/systemd/system/verified-memory-authority.service"
    reviewed = CODE + "/memory/host-ipc/verified-memory-authority.service"
    if not protected_file(deployed) or not protected_file(reviewed):
        return False
    try:
        if pathlib.Path(deployed).read_bytes() != pathlib.Path(reviewed).read_bytes():
            return False
        fields = ["FragmentPath","DropInPaths","User","Group","NoNewPrivileges",
                  "ProtectSystem","ProtectHome","PrivateTmp","ActiveState",
                  "MainPID","ExecStart"]
        cmd = ["/usr/bin/systemctl", "show", "verified-memory-authority.service",
               "--no-pager"] + ["-p" + field for field in fields]
        response = run(cmd,capture_output=True,text=True,timeout=4)
        if response.returncode:
            return False
        values = dict(line.split("=",1) for line in response.stdout.splitlines()
                      if "=" in line)
        for field,value in {
            "FragmentPath":deployed, "DropInPaths":"","User":"root",
            "Group":"bridge","NoNewPrivileges":"yes",
            "ProtectSystem":"strict","ProtectHome":"read-only",
            "PrivateTmp":"yes","ActiveState":"active",
        }.items():
            if values.get(field) != value:
                return False
        if int(values.get("MainPID","0")) <= 1:
            return False
        expected = "/usr/bin/python3 " + CODE + "/memory/host-ipc/authority-server.py"
        return expected in values.get("ExecStart","")
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return False


def audit(run=subprocess.run):
    manifest = read_activation()
    checks = {
        "rootAuthorityState": protected_dir(ROOT, 0o700),
        "reviewedAuthorityCheckout": protected_dir(CODE) and
                                     (manifest is None or reviewed_checkout(CODE, manifest["releaseSha"])),
        "sealedPythonRuntime": protected_executable(RUNTIME),
        "protectedBridgeClient": client_readable(),
        "protectedSocket": socket_live(),
        "scopedPostgresRlsAndRoles": cluster_state(manifest, run),
        "rootServiceUnitInstalled": systemd_unit_exists(),
        "operatorActivationManifest": manifest is not None,
        "trustedBridgeRelease": release_matches(manifest, run),
        "currentBridgeIdentity": bridge_identity(manifest, run),
        "controlledLiveCanary": accepted_canary(manifest),
    }
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
