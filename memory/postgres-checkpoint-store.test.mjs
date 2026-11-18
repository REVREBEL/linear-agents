import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresCheckpointStore } from './postgres-checkpoint-store.mjs';

const scope = { tenantId: 'hotel-a', agentId: 'agy', repositoryId: 'revrebel/linear-agents', issueId: 'ABR-3' };
function fakePostgres() {
  const records = new Map();
  const calls = [];
  const key = ids => JSON.stringify(ids.slice(0, 4));
  return {
    records, calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const k = key(params);
      if (sql.trimStart().startsWith('SELECT checkpoint FROM')) {
        return { rows: records.has(k) ? [{ checkpoint: records.get(k) }] : [] };
      }
      if (!sql.includes('WITH updated AS')) throw Error('Unexpected SQL');
      const [,,,, revision, json, expected] = params;
      const prior = records.get(k);
      if ((!prior && expected !== 0) || (prior && prior.revision !== expected)) return { rows: [] };
      const next = JSON.parse(json);
      assert.equal(revision, expected + 1);
      assert.equal(next.revision, revision);
      records.set(k, next);
      return { rows: [{ checkpoint: next }] };
    },
  };
}

test('creates a sanitized checkpoint and reads it within its exact scope', async () => {
  const db = fakePostgres(), store = createPostgresCheckpointStore(db);
  const written = await store.update(scope, { nextAction: 'Run tests', token: 'do-not-store' }, 0);
  assert.equal(written.revision, 1);
  assert.equal(written.token, '[REDACTED]');
  assert.equal((await store.read(scope)).nextAction, 'Run tests');
  assert.equal(await store.read({ ...scope, tenantId: 'hotel-b' }), null);
  assert.equal(await store.read({ ...scope, agentId: 'gemini' }), null);
  assert.equal(await store.read({ ...scope, issueId: 'ABR-4' }), null);
  assert.ok(db.calls.every(call => call.params.length === 4 || call.params.length === 7));
  assert.match(db.calls.find(call => call.sql.includes('WITH updated AS')).sql, /WHERE \$7 = 0/);
});

test('rejects stale revisions and prevents creating at nonzero revision', async () => {
  const db = fakePostgres(), store = createPostgresCheckpointStore(db);
  await assert.rejects(store.update(scope, { nextAction: 'bad' }, 7), { code: 'ECONFLICT' });
  await store.update(scope, { nextAction: 'first' }, 0);
  await assert.rejects(store.update(scope, { nextAction: 'stale' }, 0), { code: 'ECONFLICT' });
  const second = await store.update(scope, { nextAction: 'second' }, 1);
  assert.equal(second.revision, 2);
  assert.equal((await store.read(scope)).nextAction, 'second');
});

test('rejects invalid scopes, patches, and server-owned fields before SQL', async () => {
  const db = fakePostgres(), store = createPostgresCheckpointStore(db);
  await assert.rejects(store.read({ ...scope, tenantId: '' }), TypeError);
  await assert.rejects(store.update(scope, { revision: 99 }, 0), TypeError);
  await assert.rejects(store.update(scope, { issueId: 'different' }, 0), TypeError);
  await assert.rejects(store.update(scope, null, 0), TypeError);
  await assert.rejects(store.update(scope, {}, -1), TypeError);
  assert.equal(db.calls.length, 0);
});

test('scope is passed as parameter values, never interpolated into SQL', async () => {
  const db = fakePostgres(), store = createPostgresCheckpointStore(db);
  const malicious = { ...scope, issueId: "ABR-3'; DROP TABLE memory.agent_checkpoints; --" };
  await store.update(malicious, { nextAction: 'test' }, 0);
  assert.ok(!db.calls[0].sql.includes('DROP TABLE'));
  assert.equal(db.calls[0].params[3], malicious.issueId);
});
