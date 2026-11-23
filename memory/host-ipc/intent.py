"""Persistent completion hints; incomplete work requires manual reconciliation."""
import hashlib
import json
import os
import pathlib
import stat

ROOT = "/var/lib/bridge-memory-authority/intents"
STATES = {"queued", "running", "completed", "reconcile"}
OWNER_UID = 0


def filename(key):
    return ROOT + "/" + hashlib.sha256(key.encode()).hexdigest() + ".json"


def ensure_directory():
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    st = os.lstat(ROOT)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != OWNER_UID or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError("unsafe intent directory")


def read(key):
    try:
        fd = os.open(filename(key), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        st = os.fstat(fd)
        if st.st_uid != OWNER_UID or not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600:
            raise ValueError("unsafe intent")
        data = os.read(fd, 4097)
        if not data or len(data) > 4096:
            raise ValueError("invalid intent")
        record = json.loads(data)
        if record.get("jobKey") != key or record.get("state") not in STATES:
            raise ValueError("invalid intent")
        return record
    finally:
        os.close(fd)


def write(key, state, digest, create=False):
    if state not in STATES or len(digest) != 64:
        raise ValueError("invalid intent")
    ensure_directory()
    data = json.dumps({"jobKey": key, "state": state, "digest": digest},
                      separators=(",", ":")).encode()
    location = filename(key)
    target = location if create else location + "." + os.urandom(8).hex()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(target, flags, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    if not create:
        try:
            os.replace(target, location)
        finally:
            if os.path.exists(target):
                os.unlink(target)
    dfd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def enqueue(key, digest):
    existing = read(key)
    if existing is not None:
        if existing["digest"] != digest or existing["state"] != "completed":
            raise ValueError("already submitted; review outcome")
        return False
    write(key, "queued", digest, create=True)
    return True


def recover():
    ensure_directory()
    for name in os.listdir(ROOT):
        if not name.endswith(".json"):
            raise ValueError("unexpected artifact")
        raw = pathlib.Path(ROOT, name).read_bytes()
        record = json.loads(raw)
        if record.get("state") in ("queued", "running"):
            write(record["jobKey"], "reconcile", record["digest"])
