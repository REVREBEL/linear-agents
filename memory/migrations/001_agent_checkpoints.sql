-- Apply only to the dedicated agent_memory database, with an approved migration role.
-- Never run against wikijs_db, n8n_db, or the default postgres database.
CREATE SCHEMA IF NOT EXISTS memory;
CREATE TABLE IF NOT EXISTS memory.agent_checkpoints (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  repository_id text NOT NULL,
  issue_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, repository_id, issue_id)
);
-- Explicitly grant DML to the existing restricted runtime role, not DDL.
GRANT USAGE ON SCHEMA memory TO agent_memory_app;
GRANT SELECT, INSERT, UPDATE ON memory.agent_checkpoints TO agent_memory_app;
