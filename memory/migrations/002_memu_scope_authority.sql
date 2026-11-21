-- Reviewed operator-only migration. Quiesce memU, backup and approve activation
-- first. No automatic execution. Refuse unexpected database/schema/grant state.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog;
DO $$
BEGIN
 IF current_database() NOT IN ('agent_memory','abr59_m12') OR session_user<>current_user
 OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
 THEN RAISE EXCEPTION 'operator migration target refused'; END IF;
 IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
     AND pid<>pg_backend_pid() AND backend_type='client backend')
 OR EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL
     aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
     WHERE n.nspname='public' AND a.privilege_type='CREATE' AND a.grantee<>n.nspowner)
 THEN RAISE EXCEPTION 'quiesce client sessions and review public schema ownership first'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='memu' AND
     pg_get_userbyid(nspowner) IN ('bridge',current_user))
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='memu' AND c.relkind IN ('r','p'))<>4
 OR NOT EXISTS (SELECT 1 FROM memu.alembic_version WHERE version_num='20260703_0001')
 THEN RAISE EXCEPTION 'unexpected native memU schema'; END IF;
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='memu' AND c.relkind NOT IN ('r','i'))
 OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='memu'::regnamespace)
 OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relnamespace='memu'::regnamespace AND NOT t.tgisinternal)
 OR EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
     WHERE c.relnamespace='memu'::regnamespace)
 OR EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
     WHERE c.relnamespace='memu'::regnamespace)
 OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     WHERE n.nspname='memu' AND c.relkind IN ('r','p') AND a.grantee<>c.relowner
     AND a.grantee<>0)
 OR EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL
     aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
     WHERE n.nspname='memu' AND a.grantee<>n.nspowner AND a.grantee<>0)
 OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='memu' AND c.relkind IN ('r','p') AND
      (pg_get_userbyid(c.relowner) NOT IN ('bridge',current_user) OR c.relrowsecurity OR c.relforcerowsecurity))
 OR EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memu' AND a.attacl IS NOT NULL)
 THEN RAISE EXCEPTION 'unexpected grants or row security; review first'; END IF;
END $$;
LOCK TABLE memu.recall_files,memu.recall_file_segments,memu.resources,memu.alembic_version IN ACCESS EXCLUSIVE MODE;
-- Transfer ownership away from the agent OS/login role. Existing legacy rows
-- are preserved; they will not match a scoped bridge receipt.
ALTER SCHEMA memu OWNER TO CURRENT_USER;
ALTER TABLE memu.recall_files OWNER TO CURRENT_USER;
ALTER TABLE memu.recall_file_segments OWNER TO CURRENT_USER;
ALTER TABLE memu.resources OWNER TO CURRENT_USER;
ALTER TABLE memu.alembic_version OWNER TO CURRENT_USER;
REVOKE ALL ON SCHEMA memu FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA memu FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bridge' AND rolname<>current_user) THEN
   REVOKE ALL ON SCHEMA memu FROM bridge;
   REVOKE ALL ON ALL TABLES IN SCHEMA memu FROM bridge;
 END IF;
END $$;
CREATE ROLE bridge_memory_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE bridge_memory_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA bridge_memory_auth AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA bridge_memory_auth FROM PUBLIC;
CREATE TABLE bridge_memory_auth.scope_login (
 login_name name PRIMARY KEY,
 user_id text NOT NULL CHECK(user_id ~ '^[0-9a-f]{64}$'),
 agent_id text NOT NULL CHECK(agent_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 kind text NOT NULL CHECK(kind IN ('reader','writer')),
 UNIQUE(user_id,agent_id,kind)
);
REVOKE ALL ON bridge_memory_auth.scope_login FROM PUBLIC;
CREATE FUNCTION bridge_memory_auth.matches_scope(u text,a text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$ SELECT EXISTS(SELECT 1 FROM bridge_memory_auth.scope_login m
 WHERE m.login_name=session_user AND m.user_id=u AND m.agent_id=a) $$;
REVOKE ALL ON FUNCTION bridge_memory_auth.matches_scope(text,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA bridge_memory_auth,memu TO bridge_memory_reader,bridge_memory_writer;
GRANT EXECUTE ON FUNCTION bridge_memory_auth.matches_scope(text,text) TO bridge_memory_reader,bridge_memory_writer;
GRANT SELECT ON memu.recall_files,memu.recall_file_segments TO bridge_memory_reader,bridge_memory_writer;
GRANT INSERT ON memu.recall_files,memu.recall_file_segments TO bridge_memory_writer;
GRANT UPDATE(content,description,embedding,updated_at) ON memu.recall_files TO bridge_memory_writer;
-- No DELETE, TRUNCATE, DDL, schema migration or resources privileges.
ALTER TABLE memu.recall_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE memu.recall_files FORCE ROW LEVEL SECURITY;
ALTER TABLE memu.recall_file_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE memu.recall_file_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_file_select ON memu.recall_files FOR SELECT TO bridge_memory_reader,bridge_memory_writer
 USING (track='memory' AND name ~ '^bridge-[0-9a-f]{64}$' AND bridge_memory_auth.matches_scope(user_id,agent_id));
CREATE POLICY bridge_file_insert ON memu.recall_files FOR INSERT TO bridge_memory_writer
 WITH CHECK (track='memory' AND name ~ '^bridge-[0-9a-f]{64}$' AND bridge_memory_auth.matches_scope(user_id,agent_id));
CREATE POLICY bridge_file_update ON memu.recall_files FOR UPDATE TO bridge_memory_writer
 USING (track='memory' AND name ~ '^bridge-[0-9a-f]{64}$' AND bridge_memory_auth.matches_scope(user_id,agent_id))
 WITH CHECK (track='memory' AND name ~ '^bridge-[0-9a-f]{64}$' AND bridge_memory_auth.matches_scope(user_id,agent_id));
CREATE POLICY bridge_segment_select ON memu.recall_file_segments FOR SELECT TO bridge_memory_reader,bridge_memory_writer
 USING (track='memory' AND bridge_memory_auth.matches_scope(user_id,agent_id)
 AND EXISTS (SELECT 1 FROM memu.recall_files f WHERE f.id=recall_file_id
 AND f.user_id=recall_file_segments.user_id AND f.agent_id=recall_file_segments.agent_id AND f.track=recall_file_segments.track));
CREATE POLICY bridge_segment_insert ON memu.recall_file_segments FOR INSERT TO bridge_memory_writer
 WITH CHECK (track='memory' AND bridge_memory_auth.matches_scope(user_id,agent_id)
 AND EXISTS (SELECT 1 FROM memu.recall_files f WHERE f.id=recall_file_id
 AND f.user_id=recall_file_segments.user_id AND f.agent_id=recall_file_segments.agent_id AND f.track=recall_file_segments.track));
-- Enforce consistent parent identity for new non-null scoped segments even
-- when an administrator or future adapter attempts a mistaken write.
CREATE UNIQUE INDEX bridge_file_parent_identity ON memu.recall_files(id,user_id,agent_id,track);
ALTER TABLE memu.recall_file_segments ADD CONSTRAINT bridge_segment_parent_scope
 FOREIGN KEY(recall_file_id,user_id,agent_id,track)
 REFERENCES memu.recall_files(id,user_id,agent_id,track) NOT VALID;
CREATE UNIQUE INDEX bridge_verified_file_unique ON memu.recall_files(user_id,agent_id,name)
 WHERE track='memory' AND name ~ '^bridge-[0-9a-f]{64}$';
-- Existing mismatches are preserved but cannot enter the restricted read path.
COMMIT;
