#!/usr/bin/env bash
set -euo pipefail
[[ $(id -un) == bridge ]] || { echo 'Run as bridge' >&2; exit 1; }
umask 077
export PATH=/usr/bin:/bin
while IFS= read -r name; do
  [[ "$name" == PG* || "$name" == MEMU_* ]] && unset "$name"
done < <(compgen -e)
PG=/usr/lib/postgresql/18/bin
NODE=/opt/global-tools/volta/tools/image/node/26.13.0/bin/node
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(mktemp -d /var/tmp/abr59-m12.XXXXXXXX)
AUTH=$(mktemp -d /home/bridge/.abr59-m12.XXXXXXXX)
cleanup() {
  if [[ -f "$ROOT/data/postmaster.pid" ]]; then
    "$PG/pg_ctl" -D "$ROOT/data" -m immediate -w stop >/dev/null 2>&1 || {
      echo 'Disposable cluster stop failed; retained private directories' >&2; return 1; }
  fi
  rm -rf -- "$ROOT" "$AUTH"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$ROOT/socket" "$ROOT/home"
"$PG/initdb" -D "$ROOT/data" -A peer -U postgres --no-instructions >"$ROOT/init.log" 2>&1
"$NODE" "$HERE/memu-restricted-db-canary.mjs" --roles > "$ROOT/roles"
printf 'local all all peer map=m12fixture\n' > "$ROOT/data/pg_hba.conf"
printf 'm12fixture bridge postgres\n' > "$ROOT/data/pg_ident.conf"
while read -r reader writer user agent; do
  printf 'm12fixture bridge %s\nm12fixture bridge %s\n' "$reader" "$writer" >> "$ROOT/data/pg_ident.conf"
done < "$ROOT/roles"
start() {
  "$PG/pg_ctl" -D "$ROOT/data" -l "$ROOT/postgres.log" -o "-h '' -k $ROOT/socket -p 55441 -c unix_socket_permissions=0700" -w start >/dev/null
}
start
export PGHOST="$ROOT/socket" PGPORT=55441 PGUSER=postgres PGDATABASE=postgres
psql_private() { "$PG/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_private -c 'CREATE DATABASE abr59_m12;'
export PGDATABASE=abr59_m12
psql_private -c 'CREATE ROLE bridge NOLOGIN; CREATE SCHEMA memu; CREATE EXTENSION vector WITH SCHEMA public; ALTER DATABASE abr59_m12 SET search_path TO memu,public;'
# Bootstrap native schema as disposable administrator only; no production DSN.
dsn="postgresql://postgres@/abr59_m12?host=$PGHOST&port=55441"
printf '%s' '{"user":{"user_id":"bootstrap","agent_id":"bootstrap"},"resource":[],"recall_files":[]}' | env -i PATH=/usr/bin:/bin HOME="$ROOT/home" MEMU_CONFIG_ENV="$ROOT/no-config" MEMU_DB="$dsn" MEMU_MEMORY_MODE=local MEMU_EMBED_MODEL=nomic-embed-text MEMU_EMBED_PROVIDER=openai MEMU_BASE_URL=http://127.0.0.1:11434/v1 MEMU_API_KEY=local MEMU_TELEMETRY=0 /opt/agents/memu/.venv/bin/memu commit - --json >"$ROOT/bootstrap.log" 2>&1
# Simulate the actual legacy Bridge ownership before migration.
psql_private -c 'ALTER SCHEMA memu OWNER TO bridge; ALTER TABLE memu.recall_files OWNER TO bridge; ALTER TABLE memu.recall_file_segments OWNER TO bridge; ALTER TABLE memu.resources OWNER TO bridge; ALTER TABLE memu.alembic_version OWNER TO bridge;'
psql_private -f "$HERE/../migrations/002_memu_scope_authority.sql"
while read -r reader writer user agent; do
  psql_private -v reader="$reader" -v writer="$writer" -v user_id="$user" -v agent_id="$agent" -f "$HERE/../migrations/003_memu_scope_login.sql"
  psql_private -c "ALTER ROLE \"$reader\" LOGIN; ALTER ROLE \"$writer\" LOGIN;"
done < "$ROOT/roles"
psql_private -At -c "SELECT has_schema_privilege('bridge','memu','USAGE'),has_table_privilege('bridge','memu.recall_files','SELECT'),has_table_privilege('bridge','memu.recall_files','INSERT');" | grep -qx 'f|f|f'
"$NODE" "$HERE/memu-restricted-db-canary.mjs" "$ROOT" "$AUTH"
"$PG/pg_ctl" -D "$ROOT/data" -m fast -w stop >/dev/null
start
"$NODE" "$HERE/memu-restricted-db-canary.mjs" "$ROOT" "$AUTH" --resume
# Restore into a second fresh database in the disposable cluster. Roles are
# cluster objects, so restoration must retain both grants and scope mapping.
"$PG/pg_dump" --format=custom --file="$ROOT/restore.dump" abr59_m12
PGDATABASE=postgres psql_private -c 'CREATE DATABASE abr59_m12_restore;'
"$PG/pg_restore" --exit-on-error --dbname=abr59_m12_restore "$ROOT/restore.dump"
read -r restore_reader restore_writer restore_user restore_agent < "$ROOT/roles"
PGDATABASE=abr59_m12_restore PGUSER="$restore_reader" psql_private -At -c 'SELECT count(*) FROM memu.recall_files; SELECT count(*) FROM memu.recall_file_segments;' | grep -qx 3
PGDATABASE=abr59_m12_restore PGUSER="$restore_reader" psql_private -At -c 'SELECT count(*) FROM memu.recall_file_segments;' | grep -qx 2
if PGDATABASE=abr59_m12_restore PGUSER="$restore_reader" psql_private -c "UPDATE memu.recall_files SET content='denied'" >/dev/null 2>&1; then
  echo 'Restored reader unexpectedly writes' >&2; exit 1
fi
echo 'PASS: disposable backup/restore preserved scoped roles, rows and write denial'
psql_private -f "$HERE/../migrations/004_memu_scope_disable.sql"
read -r reader writer user agent < "$ROOT/roles"
if PGUSER="$reader" psql_private -c 'SELECT count(*) FROM memu.recall_files' >/dev/null 2>&1; then
  echo 'Disabled role still connects' >&2; exit 1
fi
psql_private -At -c 'SELECT count(*) FROM memu.recall_files' | grep -qx 7
echo 'PASS: restricted native memU PostgreSQL initial/restart, fail-closed rollback and preserved rows'
