"""Host-only memU 0.10 adapter. Input/output are bounded by the Node caller.
Use the native library's validate-only schema mode, never auto-migrate.
"""
import asyncio
import json
import os
import re
import sys

import psycopg
from sqlalchemy import URL

HEX = re.compile(r"[0-9a-f]{64}")
AGENT = re.compile(r"[A-Za-z0-9._:-]{1,128}")
NAME = re.compile(r"bridge-[0-9a-f]{64}")
ROLE = re.compile(r"bm[rw]_[0-9a-f]{56}")
OPTIONS = "-csearch_path=memu,public -cstatement_timeout=10000 -clock_timeout=3000"


def require(condition):
    if not condition:
        raise ValueError("restricted memory request denied")


def preflight(conn, role, db, identity, op):
    with conn.cursor() as cur:
        cur.execute("""
        SELECT current_database(), session_user, current_user,
          inet_server_addr() IS NULL,
          bridge_memory_auth.matches_scope(%s,%s),
          NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication),
          (SELECT count(*)=2 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
             AND c.relowner<>r.oid AND NOT pg_has_role(r.oid,c.relowner,'MEMBER'))
           FROM pg_class c WHERE c.oid IN
             ('memu.recall_files'::regclass,'memu.recall_file_segments'::regclass)),
          NOT has_schema_privilege(session_user,'memu','CREATE'),
          NOT has_table_privilege(session_user,'memu.resources','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
          has_table_privilege(session_user,'memu.recall_files','INSERT'),
          has_table_privilege(session_user,'memu.recall_file_segments','INSERT'),
          NOT has_table_privilege(session_user,'memu.recall_files','DELETE,TRUNCATE'),
          NOT has_table_privilege(session_user,'memu.recall_file_segments','DELETE,TRUNCATE'),
          NOT has_column_privilege(session_user,'memu.recall_files','user_id','UPDATE'),
          NOT has_column_privilege(session_user,'memu.recall_files','agent_id','UPDATE'),
          NOT has_column_privilege(session_user,'memu.recall_files','name','UPDATE'),
          has_column_privilege(session_user,'memu.recall_files','content','UPDATE'),
          pg_has_role(session_user,'bridge_memory_reader','MEMBER'),
          pg_has_role(session_user,'bridge_memory_writer','MEMBER'),
          NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid
            AND (m.roleid<>CASE WHEN %s THEN 'bridge_memory_writer'::regrole::oid ELSE 'bridge_memory_reader'::regrole::oid END
            OR m.admin_option OR m.set_option OR NOT m.inherit_option))
        FROM pg_roles r WHERE r.rolname=session_user
        """, (identity["user_id"], identity["agent_id"], op=="commit"))
        row = cur.fetchone()
    writer = op == "commit"
    require(row == (db,role,role,True,True,True,True,True,True,
                    writer,writer,True,True,True,True,True,writer,not writer,writer,True))


def read_rows(conn, identity, names):
    with conn.cursor() as cur:
        cur.execute("""
        SELECT f.name,f.content,f.description
        FROM memu.recall_files f
        WHERE f.name=ANY(%s) AND f.user_id=%s AND f.agent_id=%s
        AND f.track='memory' AND octet_length(f.content)<=2400
        AND public.vector_dims(f.embedding)=768
        AND (SELECT count(*) FROM memu.recall_file_segments s
          WHERE s.recall_file_id=f.id)=1
        AND EXISTS (SELECT 1 FROM memu.recall_file_segments s
          WHERE s.recall_file_id=f.id AND s.user_id=f.user_id
          AND s.agent_id=f.agent_id AND s.track=f.track
          AND s.text=f.content AND public.vector_dims(s.embedding)=768)
        ORDER BY f.updated_at DESC,f.name LIMIT 100
        """, (names, identity["user_id"], identity["agent_id"]))
        return [dict(zip(("name","content","description"), row)) for row in cur.fetchall()]


async def main():
    raw = sys.stdin.buffer.read(131073)
    require(len(raw) <= 131072)
    req = json.loads(raw)
    op, identity = req["operation"], req["identity"]
    role, db = os.environ["PGUSER"], os.environ["PGDATABASE"]
    host, port = os.environ["PGHOST"], os.environ["PGPORT"]
    require(op in ("commit","recall") and set(identity)=={"user_id","agent_id"}
            and HEX.fullmatch(identity["user_id"]) and AGENT.fullmatch(identity["agent_id"])
            and ROLE.fullmatch(role) and role.startswith("bmw_" if op=="commit" else "bmr_"))
    require((db,host,port)==("agent_memory","/var/run/postgresql","5433")
            or (db=="abr59_m12" and re.fullmatch(r"/var/tmp/abr59-m12\.[A-Za-z0-9]{8}/socket",host)
                and port=="55441"))
    # No caller-controlled DSN, password, PGOPTIONS, host, or cloud configuration.
    kwargs = dict(host=host,port=port,dbname=db,user=role,connect_timeout=5,options=OPTIONS)
    with psycopg.connect(**kwargs, autocommit=True) as conn:
        preflight(conn,role,db,identity,op)
        if op=="recall":
            names=req["names"]
            require(isinstance(names,list) and 0<len(names)<=100
                    and all(isinstance(n,str) and NAME.fullmatch(n) for n in names)
                    and len(set(names))==len(names))
            with conn.transaction():
                conn.execute("SET TRANSACTION READ ONLY")
                return {"rows":read_rows(conn,identity,names)}
        payload=req["payload"]
        require(set(payload)=={"user","resource","recall_files"} and payload["user"]==identity
                and payload["resource"]==[] and len(payload["recall_files"])==1)
        f=payload["recall_files"][0]
        require(set(f)=={"name","description","content","track"} and NAME.fullmatch(f["name"])
                and f["track"]=="memory" and isinstance(f["content"],str)
                and 0<len(f["content"])<=600 and f["content"]==f["content"].strip()
                and not f["content"].startswith("#") and not re.search(r"[\x00-\x1f\x7f]",f["content"])
                and isinstance(f["description"],str) and 0<len(f["description"])<=1024
                and f["description"]==f["description"].strip()
                and not re.search(r"[\x00-\x1f\x7f]",f["description"]))
        # An existing row (including incomplete prior work) is an ambiguous
        # commit, not permission to invoke memU's native upsert again.
        require(conn.execute("SELECT count(*) FROM memu.recall_files WHERE name=%s",(f["name"],)).fetchone()[0]==0)
        from memu.app import MemoryService
        dsn=URL.create("postgresql+psycopg",username=role,database=db,
                       query={"host":host,"port":port,"options":OPTIONS,"connect_timeout":"5"}).render_as_string(hide_password=False)
        service=MemoryService(
            database_config={"metadata_store":{"provider":"postgres","dsn":dsn,"ddl_mode":"validate"}},
            embedding_profiles={"default":{"provider":"openai","embed_model":"nomic-embed-text",
                                           "base_url":"http://127.0.0.1:11434/v1","api_key":"local"}})
        try:
            result=await service.commit_results(**payload)
        finally:
            service.database.close()
        require(result.get("resources")==[] and len(result.get("recall_files",[]))==1
                and result["recall_files"][0].get("name")==f["name"])
        # Confirm persisted exact bytes and the complete native segment, not
        # merely the CLI result. Any uncertainty is handled by the journal.
        preflight(conn,role,db,identity,op)
        require(read_rows(conn,identity,[f["name"]])==[{k:f[k] for k in ("name","content","description")}])
        return {"recall_files":[{k:f[k] for k in ("name","content","description","track")}],"resources":[]}


if __name__=="__main__":
    try:
        print(json.dumps(asyncio.run(main()),ensure_ascii=False))
    except Exception:
        # The SDK may include DSNs or payload content in exceptions.
        print("Restricted native memU operation denied",file=sys.stderr)
        sys.exit(1)
