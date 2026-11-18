import { sanitizeCheckpoint } from './active-task-memory.mjs';

const MAX_ID = 256;
function scopeId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError(`${label} must be a nonempty, bounded identifier`);
  }
  return value;
}
function scopeOf(scope) {
  if (!scope || typeof scope !== 'object') throw new TypeError('Checkpoint scope is required');
  return ['tenantId', 'agentId', 'repositoryId', 'issueId'].map(key => scopeId(scope[key], key));
}

/**
 * PostgreSQL-backed checkpoint adapter. Inject a pg-compatible Pool/Client
 * (query(sql, params) -> { rows, rowCount }); this module never opens a connection.
 *
 * The database enforces atomic compare-and-swap and scope isolation. No DDL,
 * credential handling, memU promotion, or live-job migration occurs here.
 */
export function createPostgresCheckpointStore(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A PostgreSQL query client is required');
  async function read(scope) {
    const ids = scopeOf(scope);
    const result = await db.query(
      `SELECT checkpoint FROM memory.agent_checkpoints
       WHERE tenant_id = $1 AND agent_id = $2 AND repository_id = $3 AND issue_id = $4`, ids,
    );
    return result.rows[0]?.checkpoint ?? null;
  }
  async function update(scope, patch, expectedRevision) {
    const ids = scopeOf(scope);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a nonnegative safe integer');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Checkpoint patch must be an object');
    }
    const sanitized = sanitizeCheckpoint(patch);
    // Never permit a patch to rewrite the server-owned scope or revision.
    for (const field of ['revision', 'tenantId', 'agentId', 'repositoryId', 'issueId']) {
      if (Object.hasOwn(sanitized, field)) throw new TypeError(`${field} is server-owned`);
    }
    const record = { ...sanitized, schemaVersion: 2, revision: expectedRevision + 1 };
    const result = await db.query(
      `WITH updated AS (
         UPDATE memory.agent_checkpoints
            SET revision = $5, checkpoint = $6::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND agent_id = $2 AND repository_id = $3
            AND issue_id = $4 AND revision = $7
          RETURNING checkpoint
       ), inserted AS (
         INSERT INTO memory.agent_checkpoints
           (tenant_id, agent_id, repository_id, issue_id, revision, checkpoint)
         SELECT $1, $2, $3, $4, $5, $6::jsonb
         WHERE $7 = 0 AND NOT EXISTS (SELECT 1 FROM updated)
         ON CONFLICT DO NOTHING
         RETURNING checkpoint
       )
       SELECT checkpoint FROM updated
       UNION ALL SELECT checkpoint FROM inserted`,
      [...ids, expectedRevision + 1, JSON.stringify(record), expectedRevision],
    );
    // An existing row cannot be overwritten by a stale revision; an absent
    // row is created only at revision 1.
    if (!result.rows.length) {
      const error = new Error('Checkpoint revision conflict');
      error.code = 'ECONFLICT';
      throw error;
    }
    return result.rows[0].checkpoint;
  }
  return { read, update };
}
