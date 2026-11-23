"""Disposable M12 cluster only: real SQL gate positive and unsafe-grant negatives."""
import os
import pathlib
import subprocess
import sys
from readiness import cluster_state

sock, roles_file = sys.argv[1:3]
assert sock.startswith("/var/tmp/abr59-m12.") and sock.endswith("/socket")
assert pathlib.Path(sock).is_dir()
base = dict(tenantId="tenant-a",agentId="agent-a",repositoryId="Canary/memory",issueId="CAN-1")
scopes = [base,{**base,"tenantId":"tenant-b"},{**base,"agentId":"agent-b"},
          {**base,"repositoryId":"Canary/other"},{**base,"issueId":"CAN-2"}]
manifest = {"jobs":[{"trustedJob":{"scope":scope}} for scope in scopes]}
env = {**os.environ,"PGUSER":"postgres"}
db = "/usr/lib/postgresql/18/bin/psql"


def run(argv, **kwargs):
    return subprocess.run(argv[4:],env=env,**kwargs)


def command(sql):
    result = subprocess.run([db,"-X","-qAt","-v","ON_ERROR_STOP=1",
             "-h",sock,"-p","55441","-d","abr59_m12","-c",sql],
             capture_output=True,text=True,timeout=8,env=env)
    if result.returncode:
        raise RuntimeError("disposable SQL fixture failed")


def check():
    return cluster_state(manifest,run,host=sock,port=55441,database="abr59_m12")


assert check(), "expected approved PostgreSQL 18 grants and policies to pass"
reader = pathlib.Path(roles_file).read_text().split()[0]
assert reader.startswith("bmr_") and len(reader) == 60
command('GRANT SELECT ON memu.resources TO "'+reader+'"')
assert not check(), "unsafe reader resource access accepted"
command('REVOKE SELECT ON memu.resources FROM "'+reader+'"')
assert check(), "gate did not recover after privilege restoration"
command("INSERT INTO bridge_memory_auth.scope_login VALUES ('unexpected_scope',"
        "'"+'f'*64+"','unauthorized','reader')")
assert not check(), "unapproved scope mapping accepted"
command("DELETE FROM bridge_memory_auth.scope_login WHERE login_name='unexpected_scope'")
assert check(), "gate did not recover after scope mapping restoration"
print("PASS: M14 scoped PostgreSQL policy/grant gate and negative mutations")
