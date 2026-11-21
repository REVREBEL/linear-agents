#!/usr/bin/env python3
"""Root-only operator command; no secret output; no service activation."""
import datetime as dt
import hashlib
import fcntl
import json
import os
import pathlib
import secrets
import stat
import sys

ROOT = pathlib.Path("/var/lib/bridge-memory-authority")
def private_dir(p):
    p.mkdir(mode=0o700, exist_ok=True)
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o077:
        raise RuntimeError("authority directory not root-private")
def write_exclusive(p, data):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
def sync_dir(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in ("init","rotate","revoke"):
        raise RuntimeError("root operator: init | rotate | revoke")
    os.umask(0o077)
    for p in [ROOT, ROOT/"journal", ROOT/"approvals", ROOT/"jobs"]:
        private_dir(p)
    sync_dir(ROOT.parent)
    lock=os.open(ROOT/".operator.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    st=os.fstat(lock)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077:
        raise RuntimeError("unsafe authority lock")
    fcntl.flock(lock,fcntl.LOCK_EX)
    cmd=sys.argv[1]
    active=ROOT/"active.json"
    if cmd=="init" and os.path.lexists(active):
        raise RuntimeError("already initialized")
    if cmd!="init" and not active.is_file():
        raise RuntimeError("not initialized")
    now=dt.datetime.now(dt.timezone.utc)
    key=None if cmd=="revoke" else secrets.token_bytes(32)
    if key:
        kid=hashlib.sha256(key).hexdigest()
        write_exclusive(ROOT/(kid+".key"),key)
        sync_dir(ROOT)
    else:
        # Revoked state contains no usable key identifier.
        kid="0"*64
    manifest={"keyId":kid,"notBefore":now.isoformat(),"expiresAt":(now+dt.timedelta(days=90)).isoformat(),"revoked":cmd=="revoke"}
    tmp=ROOT/(".active-"+secrets.token_hex(16))
    write_exclusive(tmp,json.dumps(manifest).encode())
    os.replace(tmp,active)
    sync_dir(ROOT)
    print("Authority",cmd,"complete; key material not displayed")
if __name__=="__main__":
    main()
