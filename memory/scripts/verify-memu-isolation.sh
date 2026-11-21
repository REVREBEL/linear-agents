#!/usr/bin/env bash
set -euo pipefail
# Run as bridge; no TCP listener, no systemd and no production DSN.
[[ $(id -un) == bridge ]] || { echo 'Run as bridge' >&2; exit 1; }
umask 077
export PATH=/usr/bin:/bin
# Ignore inherited libpq service files, database targets and options.
while IFS= read -r name; do
  [[ "$name" == PG* ]] && unset "$name"
done < <(compgen -e)
PG=/usr/lib/postgresql/18/bin
ROOT=$(mktemp -d /var/tmp/abr59-isolated.XXXXXXXX)
NODE=/opt/global-tools/volta/tools/image/node/26.13.0/bin/node
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
cleanup() {
  if [[ -f "$ROOT/data/postmaster.pid" ]]; then
    "$PG/pg_ctl" -D "$ROOT/data" -m immediate -w stop >/dev/null 2>&1 || {
      echo "Disposable PostgreSQL stop failed; retained private directory" >&2
      return 1
    }
  fi
  rm -rf -- "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$ROOT/socket" "$ROOT/home"
"$PG/initdb" -D "$ROOT/data" -A peer -U bridge --no-instructions >"$ROOT/init.log" 2>&1
"$PG/pg_ctl" -D "$ROOT/data" -l "$ROOT/postgres.log" -o "-h '' -k $ROOT/socket -p 55439 -c unix_socket_permissions=0700" -w start >/dev/null
export PGHOST="$ROOT/socket" PGPORT=55439 PGUSER=bridge PGDATABASE=postgres
"$PG/psql" -X -q -v ON_ERROR_STOP=1 -c 'CREATE DATABASE abr59_canary' >/dev/null
export PGDATABASE=abr59_canary
"$PG/psql" -X -q -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA memu; CREATE EXTENSION vector WITH SCHEMA public; ALTER DATABASE abr59_canary SET search_path TO memu, public;' >/dev/null
"$NODE" "$HERE/memu-isolation-canary.mjs" "$ROOT"
# Restart only the disposable instance, then use a fresh Node process.
"$PG/pg_ctl" -D "$ROOT/data" -m fast -w stop >/dev/null
"$PG/pg_ctl" -D "$ROOT/data" -l "$ROOT/postgres.log" -o "-h '' -k $ROOT/socket -p 55439 -c unix_socket_permissions=0700" -w start >/dev/null
"$NODE" "$HERE/memu-isolation-canary.mjs" "$ROOT" --resume
