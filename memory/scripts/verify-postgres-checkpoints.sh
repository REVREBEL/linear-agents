#!/usr/bin/env bash
set -euo pipefail
# Disposable PostgreSQL cluster; never touches systemd or /var/lib/postgresql.
PORT=55439
if ss -ltn "( sport = :$PORT )" | grep -q LISTEN; then echo 'Test port busy; refusing to continue' >&2; exit 1; fi
ROOT=$(mktemp -d /tmp/abr3-pg-isolated.XXXXXXXX)
chmod 700 "$ROOT"
chown postgres:postgres "$ROOT"
mkdir "$ROOT/data" "$ROOT/sock"
chown postgres:postgres "$ROOT/data" "$ROOT/sock"
started=0
cleanup() {
  if [[ "$started" == 1 ]]; then runuser -u postgres -- /usr/lib/postgresql/18/bin/pg_ctl -D "$ROOT/data" -m immediate stop >/dev/null 2>&1 || true; fi
  rm -rf -- "$ROOT"
}
trap cleanup EXIT
runuser -u postgres -- /usr/lib/postgresql/18/bin/initdb -D "$ROOT/data" -A trust -U postgres --no-instructions >/dev/null
runuser -u postgres -- /usr/lib/postgresql/18/bin/pg_ctl -D "$ROOT/data" -l "$ROOT/server.log" -o "-p $PORT -h 127.0.0.1 -k $ROOT/sock" start >/dev/null
started=1
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
psql -X -v ON_ERROR_STOP=1 -q -c 'CREATE ROLE agent_memory_app NOLOGIN;'
psql -X -v ON_ERROR_STOP=1 -q -c 'CREATE DATABASE abr3_test;'
export PGDATABASE=abr3_test
psql -X -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/../migrations/001_agent_checkpoints.sql"
psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
-- Atomic first insert must succeed at expected revision 0.
WITH updated AS (
  UPDATE memory.agent_checkpoints SET revision=1, checkpoint='{"revision":1}'::jsonb,updated_at=now()
  WHERE tenant_id='t1' AND agent_id='a1' AND repository_id='repo' AND issue_id='ABR-3' AND revision=0
  RETURNING checkpoint
), inserted AS (
  INSERT INTO memory.agent_checkpoints (tenant_id,agent_id,repository_id,issue_id,revision,checkpoint)
  SELECT 't1','a1','repo','ABR-3',1,'{"revision":1}'::jsonb
  WHERE 0=0 AND NOT EXISTS (SELECT 1 FROM updated)
  ON CONFLICT DO NOTHING RETURNING checkpoint
)
SELECT checkpoint FROM updated UNION ALL SELECT checkpoint FROM inserted;
-- An update from revision 1 must advance to 2.
WITH updated AS (
  UPDATE memory.agent_checkpoints SET revision=2, checkpoint='{"revision":2}'::jsonb,updated_at=now()
  WHERE tenant_id='t1' AND agent_id='a1' AND repository_id='repo' AND issue_id='ABR-3' AND revision=1
  RETURNING checkpoint
), inserted AS (
  INSERT INTO memory.agent_checkpoints (tenant_id,agent_id,repository_id,issue_id,revision,checkpoint)
  SELECT 't1','a1','repo','ABR-3',2,'{"revision":2}'::jsonb
  WHERE 1=0 AND NOT EXISTS (SELECT 1 FROM updated)
  ON CONFLICT DO NOTHING RETURNING checkpoint
)
SELECT checkpoint FROM updated UNION ALL SELECT checkpoint FROM inserted;
DO $$ BEGIN
  IF (SELECT revision FROM memory.agent_checkpoints WHERE tenant_id='t1' AND agent_id='a1' AND repository_id='repo' AND issue_id='ABR-3') <> 2 THEN
    RAISE EXCEPTION 'revision mismatch'; END IF;
  IF (SELECT count(*) FROM memory.agent_checkpoints WHERE tenant_id='t2') <> 0 THEN
    RAISE EXCEPTION 'tenant isolation failed'; END IF;
END $$;
SQL
# Verify runtime role has DML but no schema DDL.
psql -X -v ON_ERROR_STOP=1 -At -c "SELECT has_table_privilege('agent_memory_app','memory.agent_checkpoints','SELECT'),has_table_privilege('agent_memory_app','memory.agent_checkpoints','UPDATE'),has_schema_privilege('agent_memory_app','memory','CREATE')" | grep -qx 't|t|f'
echo 'PASS: disposable PostgreSQL 18 cluster; schema migration, insert, CAS update, scoped query, and role privileges'
