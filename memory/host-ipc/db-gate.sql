-- Operator-only, read-only PostgreSQL 18 metadata inspection.
-- A psql variable carries JSON; no model-derived SQL identifiers are interpolated.
-- PostgreSQL pg_get_expr adds schema qualifiers depending on search_path.
-- Pin the namespace used when the five exact policy fingerprints were audited.
SET search_path=memu,public;
WITH bindings AS (
 SELECT DISTINCT * FROM jsonb_to_recordset(:'bindings'::jsonb)
 AS b(reader text, writer text, user_id text, agent_id text)
),
expected_policies(name, command, md5def, table_name) AS (
 VALUES
 ('bridge_file_insert','a','8726f7b93bd443dda2df55c9a64b3885','recall_files'),
 ('bridge_file_select','r','25caa50a59a39a759f6c480eaf1f82bf','recall_files'),
 ('bridge_file_update','w','154c41d1d1b61f145a192bb96606273e','recall_files'),
 ('bridge_segment_insert','a','58abfb09beb856b443e1afa044d7a212','recall_file_segments'),
 ('bridge_segment_select','r','53e17fd0258cb7de0d9c341cf482bfed','recall_file_segments')
),
actual_policies AS (
 SELECT p.polname AS name,p.polcmd AS command,
  md5(coalesce(pg_get_expr(p.polqual,p.polrelid),'')||'|'||
      coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) AS md5def,
  c.relname AS table_name,p.polpermissive,
  ARRAY(SELECT rolname::text FROM pg_roles WHERE oid=ANY(p.polroles)
      ORDER BY rolname) AS roles
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
 WHERE p.polrelid IN ('memu.recall_files'::regclass,
                       'memu.recall_file_segments'::regclass)
),
grants_ok AS (
 SELECT coalesce(bool_and(
   has_table_privilege(reader,'memu.recall_files','SELECT') AND
   has_table_privilege(reader,'memu.recall_file_segments','SELECT') AND
   NOT has_table_privilege(reader,'memu.recall_files','INSERT,UPDATE,DELETE,TRUNCATE') AND
   NOT has_table_privilege(reader,'memu.recall_file_segments','INSERT,UPDATE,DELETE,TRUNCATE') AND
   has_table_privilege(writer,'memu.recall_files','SELECT') AND
   has_table_privilege(writer,'memu.recall_files','INSERT') AND
   has_table_privilege(writer,'memu.recall_file_segments','SELECT') AND
   has_table_privilege(writer,'memu.recall_file_segments','INSERT') AND
   NOT has_table_privilege(writer,'memu.recall_files','DELETE,TRUNCATE') AND
   NOT has_table_privilege(writer,'memu.recall_file_segments','UPDATE,DELETE,TRUNCATE') AND
   has_column_privilege(writer,'memu.recall_files','content','UPDATE') AND
   NOT has_column_privilege(writer,'memu.recall_files','user_id','UPDATE') AND
   NOT has_column_privilege(writer,'memu.recall_files','agent_id','UPDATE') AND
   NOT has_column_privilege(writer,'memu.recall_files','name','UPDATE') AND
   NOT has_schema_privilege(reader,'memu','CREATE') AND
   NOT has_schema_privilege(writer,'memu','CREATE') AND
   NOT has_table_privilege(reader,'memu.resources','SELECT') AND
   NOT has_table_privilege(writer,'memu.resources','SELECT')
 ),false) AS ok FROM bindings
),
scope_ok AS (
 SELECT count(*)=(SELECT 2*count(*) FROM bindings) AND
  count(*)>0 AND bool_and(
   (kind='reader' AND EXISTS (SELECT 1 FROM bindings b WHERE b.reader=login_name
     AND b.user_id=m.user_id AND b.agent_id=m.agent_id))
   OR (kind='writer' AND EXISTS (SELECT 1 FROM bindings b WHERE b.writer=login_name
     AND b.user_id=m.user_id AND b.agent_id=m.agent_id))
  ) AS ok FROM bridge_memory_auth.scope_login m
),
roles_ok AS (
 SELECT count(*)=(SELECT 2+2*count(*) FROM bindings) AND
  bool_and(NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
   AND NOT rolreplication AND
    (CASE WHEN rolname IN ('bridge_memory_reader','bridge_memory_writer')
      THEN NOT rolcanlogin AND NOT rolinherit ELSE rolcanlogin AND rolinherit END))
  AS ok FROM pg_roles
  WHERE rolname IN ('bridge_memory_reader','bridge_memory_writer')
     OR rolname IN (SELECT reader FROM bindings UNION SELECT writer FROM bindings)
),
membership_ok AS (
 SELECT count(*)=(SELECT 2*count(*) FROM bindings) AND
  bool_and(NOT admin_option AND NOT set_option AND inherit_option AND
    ((parent.rolname='bridge_memory_reader' AND child.rolname IN
       (SELECT reader FROM bindings)) OR
     (parent.rolname='bridge_memory_writer' AND child.rolname IN
       (SELECT writer FROM bindings)))) AS ok
 FROM pg_auth_members gm
 JOIN pg_roles parent ON parent.oid=gm.roleid
 JOIN pg_roles child ON child.oid=gm.member
 WHERE child.rolname IN (SELECT reader FROM bindings UNION SELECT writer FROM bindings)
)
SELECT
 current_database()=:'expected_database' AND
 (SELECT count(*)=2 AND bool_and(relrowsecurity AND relforcerowsecurity
     AND pg_get_userbyid(relowner) NOT IN ('bridge','bridge_memory_reader','bridge_memory_writer'))
    FROM pg_class WHERE oid IN ('memu.recall_files'::regclass,
     'memu.recall_file_segments'::regclass)) AND
 (SELECT count(*)=5 FROM actual_policies) AND
 (SELECT count(*)=5 AND bool_and(a.polpermissive AND
    a.command=e.command AND a.md5def=e.md5def AND a.table_name=e.table_name
    AND (a.command='r' AND a.roles=ARRAY['bridge_memory_reader','bridge_memory_writer']::text[]
       OR a.command IN ('a','w') AND a.roles=ARRAY['bridge_memory_writer']::text[]))
 FROM actual_policies a JOIN expected_policies e ON e.name=a.name) AND
 (SELECT ok FROM grants_ok) AND (SELECT ok FROM scope_ok) AND
 (SELECT ok FROM roles_ok) AND (SELECT ok FROM membership_ok) AND
 NOT has_table_privilege('bridge','memu.recall_files','SELECT,INSERT,UPDATE,DELETE') AND
 NOT has_table_privilege('bridge','memu.recall_file_segments','SELECT,INSERT,UPDATE,DELETE');
