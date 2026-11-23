"""M14 protected Unix IPC. Source-only until separately approved deployment.

The authenticated main Bridge PID is pinned by the root-owned manifest. Agent
children run under the same uid, so checking uid/group/cgroup alone is UNSAFE.
"""
import concurrent.futures
import json
import os
import pathlib
import pwd as accounts
import re
import socket
import stat
import struct
import subprocess
import sys
import threading

ROOT = "/var/lib/bridge-memory-authority"
CODE = "/var/lib/bridge-memory-authority-code"
SOCKET_DIR = "/run/bridge-memory-authority"
SOCKET_PATH = SOCKET_DIR + "/bridge.sock"
MANIFEST = ROOT + "/activation.json"
WORKER = CODE + "/memory/host-ipc/operator-worker.mjs"
UNIT = "agent-bridge.service"
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
HASH = re.compile(r"^[a-f0-9]{40}$")
KEY = re.compile(r"^[a-zA-Z0-9._:-]{1,256}$")
ISSUE = re.compile(r"^(?:[a-f0-9-]{36}|[A-Za-z]+-[0-9]+)$", re.I)


class Refused(Exception):
    pass


def need(value):
    if not value:
        raise Refused("authority denied")


def trusted_path(filename, is_dir=False):
    need(os.path.isabs(filename) and os.path.normpath(filename) == filename)
    current = pathlib.Path(filename)
    parts = [current, *current.parents]
    for node in parts:
        s = node.lstat()
        need(s.st_uid == 0 and not s.st_mode & 0o022)
        need(stat.S_ISDIR(s.st_mode) if node != current or is_dir
             else stat.S_ISREG(s.st_mode))


def private_config(filename=MANIFEST):
    trusted_path(ROOT, is_dir=True)
    trusted_path(filename)
    need(stat.S_IMODE(os.stat(ROOT).st_mode) == 0o700)
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        need(st.st_uid == 0 and stat.S_ISREG(st.st_mode) and
             stat.S_IMODE(st.st_mode) == 0o600 and 0 < st.st_size <= 16384)
        raw = os.read(fd, 16385)
        need(0 < len(raw) <= 16384)
        return checked_manifest(json.loads(raw))
    finally:
        os.close(fd)


def checked_manifest(m):
    need(type(m) is dict and set(m) == {"schemaVersion", "activation",
          "bridge", "repositories", "jobs", "releaseSha"})
    need(m["schemaVersion"] == 1 and m["activation"] is True)
    bridge = m["bridge"]
    need(type(bridge) is dict and set(bridge) == {"pid", "startTicks", "unit", "entrypoint"}
         and type(bridge["pid"]) is int and bridge["pid"] > 1
         and type(bridge["startTicks"]) is str and bridge["startTicks"].isdigit()
         and bridge["unit"] == UNIT and type(bridge["entrypoint"]) is str
         and bridge["entrypoint"].startswith("/var/lib/bridge-runtime/")
         and bridge["entrypoint"].endswith("/linear-agent-bridge/agent-bridge.mjs"))
    need(type(m["releaseSha"]) is str and HASH.fullmatch(m["releaseSha"]))
    repos = m["repositories"]
    need(type(repos) is dict and 0 < len(repos) <= 16)
    for root, repo in repos.items():
        need(type(root) is str and root.startswith("/") and
             os.path.normpath(root) == root and REPO.fullmatch(repo))
    jobs = m["jobs"]
    need(type(jobs) is list and 0 < len(jobs) <= 32)
    seen = set()
    for record in jobs:
        need(type(record) is dict and set(record) == {"jobKey", "trustedJob", "policy", "sourcePath"})
        key, job = record["jobKey"], record["trustedJob"]
        need(type(key) is str and KEY.fullmatch(key) and key not in seen)
        seen.add(key)
        need(type(job) is dict and set(job) == {"jobId", "scope", "prNumber", "headSha"}
             and type(job["jobId"]) is str and KEY.fullmatch(job["jobId"])
             and type(job["prNumber"]) is int and job["prNumber"] > 0
             and HASH.fullmatch(job["headSha"]))
        scope = job["scope"]
        need(type(scope) is dict and set(scope) == {"tenantId", "agentId", "repositoryId", "issueId"}
             and all(type(v) is str and 1 <= len(v) <= 128 for v in scope.values())
             and REPO.fullmatch(scope["repositoryId"]) and ISSUE.fullmatch(scope["issueId"])
             and scope["repositoryId"] in repos.values())
        need(type(record["sourcePath"]) is str and
             re.fullmatch(r"docs/verified-learnings/[A-Za-z0-9_/-]+\.(?:md|txt)", record["sourcePath"])
             and "//" not in record["sourcePath"] and ".." not in record["sourcePath"])
        policy = record["policy"]
        need(type(policy) is dict and set(policy) == {"requiredChecks", "allowedCheckApps", "permittedReviewers"}
             and all(type(policy[x]) is list and 0 < len(policy[x]) <= 30 and
                     all(type(y) is str and 1 <= len(y) <= 128 for y in policy[x])
                     for x in policy))
    return m


def process_start_ticks(pid):
    # The comm field may include whitespace/parentheses: parse from final ')'.
    raw = pathlib.Path(f"/proc/{pid}/stat").read_text()
    return raw[raw.rfind(")") + 2:].split()[19]


def current_main_pid():
    output = subprocess.run(["/usr/bin/systemctl", "show", "--value", "-p", "MainPID", UNIT],
                            capture_output=True, text=True, timeout=2, check=True)
    return int(output.stdout.strip())


def peer_authorized(conn, manifest, main_pid_reader=current_main_pid):
    pid, uid, gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    bridge = manifest["bridge"]
    try:
        expected = accounts.getpwnam("bridge")
    except KeyError:
        raise Refused("authority denied") from None
    need(uid == expected.pw_uid and gid == expected.pw_gid)
    need(pid == bridge["pid"] and pid == main_pid_reader())
    need(process_start_ticks(pid) == bridge["startTicks"])
    need("0::/system.slice/agent-bridge.service" in pathlib.Path(f"/proc/{pid}/cgroup").read_text().splitlines())
    # Even the correctly pinned PID must have a root-owned, non-writable
    # entrypoint and all ancestors. Otherwise a shared-uid agent can change
    # the next Bridge runtime and impersonate approved memory requests.
    exe = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\x00")
    need(len(exe) >= 2 and exe[1].decode("utf-8") == bridge["entrypoint"])
    trusted_path(bridge["entrypoint"])
    return True


def read_message(conn):
    conn.settimeout(2)
    data = bytearray()
    while len(data) <= 2048:
        chunk = conn.recv(min(2049 - len(data), 1024))
        if not chunk:
            break
        data.extend(chunk)
        if b"\n" in data:
            break
    need(0 < len(data) <= 2048 and data.endswith(b"\n") and data.count(b"\n") == 1)
    return json.loads(data)


def _worker(op, key, timeout):
    # Never pass the caller's JSON, environment, shell, cwd or credential to
    # a privileged child. The worker independently reloads the pinned manifest.
    trusted_path(WORKER)
    result = subprocess.run(["/usr/bin/node", WORKER, op, key], cwd=CODE,
        env={"PATH": "/usr/bin:/bin", "HOME": ROOT, "LANG": "C.UTF-8"},
        capture_output=True, text=True, timeout=timeout, check=True)
    need(len(result.stdout) <= 12288)
    return json.loads(result.stdout)


def dispatch(message, manifest, worker=_worker, scheduler=None):
    need(type(message) is dict and isinstance(message.get("op"), str))
    repos = manifest["repositories"]
    op = message["op"]
    if op == "repo":
        need(set(message) == {"op", "repositoryRoot"} and type(message["repositoryRoot"]) is str)
        value = repos.get(message["repositoryRoot"])
        need(value is not None)
        return {"ok": True, "repositoryId": value}
    if op == "recall":
        need(set(message) == {"op", "tenantId", "agentId", "repositoryRoot", "issueId", "jobKey"})
        need(all(type(message[k]) is str for k in message if k != "op"))
        repo = repos.get(message["repositoryRoot"])
        need(repo is not None)
        matches = [j for j in manifest["jobs"] if j["jobKey"] == message["jobKey"] and
          j["trustedJob"]["scope"] == dict(tenantId=message["tenantId"], agentId=message["agentId"],
          repositoryId=repo, issueId=message["issueId"])]
        need(len(matches) == 1)
        return {"ok": True, "result": worker("recall", message["jobKey"], 8)}
    if op == "complete":
        need(set(message) == {"op", "issueId"} and type(message["issueId"]) is str
             and ISSUE.fullmatch(message["issueId"]))
        matching = [j for j in manifest["jobs"] if j["trustedJob"]["scope"]["issueId"] == message["issueId"]]
        need(len(matching) == 1 and scheduler is not None)
        scheduler(matching[0]["jobKey"], message["issueId"])
        return {"ok": True, "accepted": True}
    raise Refused("authority denied")


def serve_one(conn, executor, pending, main_pid_reader=current_main_pid):
    try:
        manifest = private_config()
        peer_authorized(conn, manifest, main_pid_reader)
        request = read_message(conn)
        def schedule(key, issue):
            with pending["lock"]:
                need(key not in pending["keys"])
                pending["keys"].add(key)
            def task():
                try:
                    _worker("promote", key, 75)
                    print("memory event: promotion-processed", flush=True)
                except Exception:
                    print("memory event: promotion-denied-or-reconciliation", flush=True)
                finally:
                    with pending["lock"]:
                        pending["keys"].discard(key)
            try:
                executor.submit(task)
            except Exception:
                with pending["lock"]:
                    pending["keys"].discard(key)
                raise
        answer = dispatch(request, manifest, scheduler=schedule)
        raw = json.dumps(answer, separators=(",", ":")).encode() + b"\n"
        need(len(raw) <= 12288)
        conn.sendall(raw)
    except Exception:
        # No exception, path, credential, SQL, content or caller data is logged.
        try:
            conn.sendall(b'{"ok":false,"error":"denied"}\n')
        except Exception:
            pass
    finally:
        conn.close()


def main():
    need(os.geteuid() == 0 and os.getuid() == 0)
    trusted_path(CODE, is_dir=True)
    trusted_path(__file__)
    checked = private_config()
    version = subprocess.run(["/usr/bin/git", "rev-parse", "HEAD"],cwd=CODE,
        env={"PATH":"/usr/bin:/bin", "HOME":"/nonexistent", "GIT_CONFIG_NOSYSTEM":"1",
             "GIT_CONFIG_GLOBAL":"/dev/null", "GIT_NO_REPLACE_OBJECTS":"1"},
        capture_output=True,text=True,timeout=3,check=True)
    need(version.stdout.strip() == checked["releaseSha"])
    expected_group = accounts.getpwnam("bridge").pw_gid
    try:
        os.mkdir(SOCKET_DIR, mode=0o750)
    except FileExistsError:
        pass
    s = os.lstat(SOCKET_DIR)
    need(s.st_uid == 0 and stat.S_ISDIR(s.st_mode) and not s.st_mode & 0o027)
    os.chown(SOCKET_DIR, 0, expected_group)
    if os.path.lexists(SOCKET_PATH):
        s = os.lstat(SOCKET_PATH)
        need(s.st_uid == 0 and stat.S_ISSOCK(s.st_mode))
        os.unlink(SOCKET_PATH)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    os.chown(SOCKET_PATH, 0, expected_group)
    os.chmod(SOCKET_PATH, 0o660)
    server.listen(8)
    pending = {"keys": set(), "lock": threading.Lock()}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            client, _ = server.accept()
            pool.submit(serve_one, client, pool, pending)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("memory authority startup refused", file=sys.stderr)
        sys.exit(1)
