-- Fail-closed rollback: disable all scope logins and revoke grants without
-- dropping memory rows or restoring the historical broad agent ownership.
BEGIN;
SET LOCAL search_path=pg_catalog;
DO $$
DECLARE x record;
BEGIN
 IF current_database() NOT IN ('agent_memory','abr59_m12') OR session_user<>current_user
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
 THEN RAISE EXCEPTION 'operator disable refused'; END IF;
 FOR x IN SELECT login_name FROM bridge_memory_auth.scope_login LOOP
   EXECUTE format('ALTER ROLE %I NOLOGIN',x.login_name);
   EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I',current_database(),x.login_name);
   PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=x.login_name AND pid<>pg_backend_pid();
 END LOOP;
END $$;
REVOKE SELECT,INSERT,UPDATE ON memu.recall_files,memu.recall_file_segments FROM bridge_memory_reader,bridge_memory_writer;
REVOKE UPDATE(content,description,embedding,updated_at) ON memu.recall_files FROM bridge_memory_writer;
REVOKE USAGE ON SCHEMA memu,bridge_memory_auth FROM bridge_memory_reader,bridge_memory_writer;
COMMIT;
