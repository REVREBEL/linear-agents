-- Explicit psql parameters reader, writer, user_id, agent_id. Create disabled
-- credentials first. Operator must separately configure root-only peer mapping.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
SELECT set_config('bridge_provision.reader', :'reader', true) AS reader_config,set_config('bridge_provision.writer', :'writer', true) AS writer_config,
 set_config('bridge_provision.user', :'user_id', true) AS user_config,set_config('bridge_provision.agent', :'agent_id', true) AS agent_config \gset
DO $$
DECLARE r text:=current_setting('bridge_provision.reader'); w text:=current_setting('bridge_provision.writer');
 u text:=current_setting('bridge_provision.user'); a text:=current_setting('bridge_provision.agent');
BEGIN
 IF current_database() NOT IN ('agent_memory','abr59_m12') OR session_user<>current_user
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR r !~ '^bmr_[0-9a-f]{56}$' OR w !~ '^bmw_[0-9a-f]{56}$' OR substring(r from 5)<>substring(w from 5)
 OR u !~ '^[0-9a-f]{64}$' OR a !~ '^[A-Za-z0-9._:-]{1,128}$'
 OR substring(r from 5)<>left(encode(sha256(convert_to('["'||u||'","'||a||'"]','UTF8')),'hex'),56)
 THEN RAISE EXCEPTION 'scope provisioning refused'; END IF;
 EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL',r);
 EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL',w);
 EXECUTE format('GRANT bridge_memory_reader TO %I WITH INHERIT TRUE, SET FALSE',r);
 EXECUTE format('GRANT bridge_memory_writer TO %I WITH INHERIT TRUE, SET FALSE',w);
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I,%I',current_database(),r,w);
 INSERT INTO bridge_memory_auth.scope_login VALUES(r,u,a,'reader'),(w,u,a,'writer');
END $$;
COMMIT;
