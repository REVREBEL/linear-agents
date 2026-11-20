/** ABR-87 E3: scope boundaries for checkpoint, recall and README context. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createPostgresCheckpointStore } from './postgres-checkpoint-store.mjs';
import { compactRecall, retrieveMemuMemory, verifiedRecallScope } from './memu-memory.mjs';
import { validatePromotion } from '../scripts/memu-promote.mjs';
import { prepareLocalAgentTask } from '../jobs/preparation/local-task-preparation.mjs';

const ROOT = new URL('../', import.meta.url);
const scope = {
  tenantId: 'org-one', agentId: 'qwen-local',
  repositoryId: 'REVREBEL/linear-agents', issueId: 'ABR-87',
};
const proof = {
  issueId: 'ABR-87', review: { status: 'approved', headSha: 'a'.repeat(40) },
  tests: { status: 'passed', headSha: 'a'.repeat(40) },
};

function fakeDb() {
  const rows = new Map();
  const key = values => JSON.stringify(values.slice(0, 4));
  return {
    rows,
    async query(sql, values) {
      const k = key(values);
      if (sql.trimStart().startsWith('SELECT checkpoint FROM'))
        return { rows: rows.has(k) ? [{checkpoint: rows.get(k)}] : [] };
      assert.match(sql, /WHERE tenant_id = \$1 AND agent_id = \$2 AND repository_id = \$3/);
      const current = rows.get(k), [, , , , revision, payload, expected] = values;
      if ((!current && expected !== 0) || (current && current.revision !== expected))
        return { rows: [] };
      const next = JSON.parse(payload);
      assert.equal(next.revision, revision);
      rows.set(k, next);
      return { rows: [{ checkpoint: next }] };
    },
  };
}

function simulatedMemu(payload, onSpawn = () => {}) {
  return (_bin, argv, options) => {
    onSpawn(argv, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.write(JSON.stringify(payload));
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };
}

test('checkpoint CAS and restart isolate tenant, agent, repository and issue independently', async () => {
  const db = fakeDb();
  const store = createPostgresCheckpointStore(db);
  const other = [
    { ...scope, tenantId: 'org-two' },
    { ...scope, agentId: 'chatgpt-cli' },
    { ...scope, repositoryId: 'REVREBEL/booking-engine' },
    { ...scope, issueId: 'ABR-88' },
  ];
  await store.update(scope, { nextAction: 'Qwen revision one', token: 'private' }, 0);
  for (let i = 0; i < other.length; i++) {
    assert.equal(await store.read(other[i]), null, 'no cross-scope read before write');
    await store.update(other[i], { nextAction: 'isolated ' + i }, 0);
  }
  const restarted = createPostgresCheckpointStore(db);
  assert.equal((await restarted.read(scope)).nextAction, 'Qwen revision one');
  assert.equal((await restarted.read(scope)).token, '[REDACTED]');
  for (let i = 0; i < other.length; i++)
    assert.equal((await restarted.read(other[i])).nextAction, 'isolated ' + i);
  await restarted.update(scope, { nextAction: 'Qwen revision two' }, 1);
  await assert.rejects(store.update(scope, { nextAction: 'stale' }, 1), { code: 'ECONFLICT' });
  for (const otherScope of other)
    assert.equal((await restarted.read(otherScope)).revision, 1);
});

test('memU recall refuses incomplete tenant/agent/repository/issue scope before subprocess', async () => {
  let calls = 0;
  const spawnImpl = () => { calls++; throw Error('must not launch'); };
  for (const invalid of [null, {}, { ...scope, issueId: '' }, { ...scope, agentId: null },
    { ...scope, repositoryId: '\ninvalid' }, { agentId: 'qwen-local', repositoryId: 'repo', issueId: 'ABR-87' }]) {
    assert.equal(verifiedRecallScope(invalid), null);
    assert.equal(await retrieveMemuMemory('README content', {
      enabled: true, scope: invalid, spawnImpl, logger: { warn() {} },
    }), '');
  }
  assert.equal(calls, 0);
});

test('memU recall releases only exact attributed matches and rejects untagged or foreign scope', async () => {
  const hits = [
    { text: 'unattributed private note' },
    { text: 'wrong agent', metadata: { scope: { ...scope, agentId: 'chatgpt-cli' } } },
    { text: 'wrong issue', scope: { ...scope, issueId: 'ABR-12' } },
    { text: 'wrong repo', scope: { ...scope, repositoryId: 'other/repo' } },
    { text: 'wrong tenant', scope: { ...scope, tenantId: 'other-tenant' } },
    { text: 'scoped approved detail', scope },
  ];
  let called = 0;
  const output = await retrieveMemuMemory('find previous task', {
    enabled: true, scope, logger: { warn() {} },
    spawnImpl: simulatedMemu({ segments: hits }, (argv, opts) => {
      called++;
      assert.deepEqual(argv, ['retrieve', 'find previous task']);
      assert.equal(opts.shell, false);
    }),
  });
  assert.equal(called, 1);
  assert.equal(output, 'scoped approved detail');
  assert.equal(compactRecall({ segments: hits }, 5, scope), output);
  assert.equal(compactRecall({ segments: hits.slice(0, 5) }, 5, scope), '');
});


test('local task preparation passes issue, agent, repository and tenant scope to memU', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abr87-preparation-'));
  try {
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    const requested = [];
    const job = {
      issueId: 'ABR-87', organizationId: 'org-one',
      agentSessionId: 'ses1', payload: { data: { promptContext: 'Review tests' } },
    };
    const route = {
      repositoryRoot: repo, launchDirectory: repo, scopeKey: 'local',
      projectScope: 'project', projectId: 'linear-project', agentRole: 'coding',
    };
    await prepareLocalAgentTask({
      job, route, agent: 'qwen-local', jobKey: 'job-one', safeJobId: 'job-one',
      jobStore: { transition: async () => {} },
      activeTaskMemory: {
        read: async () => null, recoveryPreamble: () => '', update: async () => {},
      },
      drainProgressWrites: async () => {},
      retrieveMemuMemory: async (query, options) => {
        requested.push({ query, scope: options.scope });
        return '';
      },
      extractDirectTask: value => value, extractPromptContext: payload => payload.payload.data.promptContext,
      logger: { warn() {}, log() {} },
    });
    assert.equal(requested.length, 1);
    assert.deepEqual(requested[0].scope, {
      tenantId: 'org-one', agentId: 'qwen-local',
      repositoryId: repo, issueId: 'ABR-87',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('README context retrieval cannot call memU or serve as canonical promotion proof', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abr87-context-only-'));
  try {
    const tool = path.join(root, 'fake-memu');
    const marker = path.join(root, 'memu-invoked');
    await writeFile(tool, '#!/bin/sh\nprintf invoked > "' + marker + '"\n', { mode: 0o700 });
    const env = { ...process.env, MEMU_BIN: tool, MEMU_RETRIEVAL_ENABLED: 'true' };
    for (const [name, dir] of [
      ['AGENT_CONTEXT_AGENTS_ROOT', 'agents'],
      ['AGENT_CONTEXT_AGENT_TOOLS_ROOT', 'agent-tools'],
      ['AGENT_CONTEXT_GLOBAL_TOOLS_ROOT', 'global-tools'],
    ]) {
      const destination = path.join(root, dir);
      await mkdir(destination);
      const blob = execFileSync('git', ['-C', new URL('.', ROOT).pathname, 'show',
        'HEAD:templates/context/host-roots/' + dir + '/README.md']);
      await writeFile(path.join(destination, 'README.md'), blob);
      env[name] = destination;
    }
    const cmd = spawnSync('python3', [
      new URL('scripts/agent_context_cli.py', ROOT).pathname,
      '--repo-root', new URL('.', ROOT).pathname, '--topic', 'memory', '--format', 'json',
    ], { env, cwd: root, encoding: 'utf8' });
    assert.equal(cmd.status, 0, cmd.stderr);
    const bundle = JSON.parse(cmd.stdout);
    assert.ok(bundle.documents.some(doc => doc.id === 'repo.memory'));
    assert.equal(bundle.partial, false);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.throws(() => validatePromotion(bundle, proof), /genuine canonical memU session/);
    assert.throws(() => validatePromotion({
      schema_version: '1.0',
      items: [{ type: 'context', content: JSON.stringify(bundle) }],
    }, proof), /genuine canonical memU session/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
