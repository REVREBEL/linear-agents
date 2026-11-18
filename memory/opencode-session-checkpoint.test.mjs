import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createActiveTaskMemory } from './active-task-memory.mjs';
import { updateOpenCodeCheckpoint, recordOpenCodeProgress } from './opencode-session-checkpoint.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-memory-'));
  try {
    const memory = createActiveTaskMemory(root);
    const job = { repositoryRoot: '/repo/REVREBEL/linear-agents', issueId: 'ABR-57' };
    const jobStore = { get: async key => key === 'job-current' ? job : null };
    await memory.update(job.repositoryRoot, job.issueId, {
      lastJobKey: 'job-current', lastAgent: 'chatgpt-cli', lastSessionId: 'linear-session-1',
    });
    await run({ memory, jobStore, repo: job.repositoryRoot, issue: job.issueId });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('OpenCode provider session is persisted separately from Linear session identity', async () => fixture(async ({ memory, jobStore, repo, issue }) => {
  assert.equal(await updateOpenCodeCheckpoint({ jobStore, memory, jobKey: 'job-current', patch: {
    lastProviderSessionId: 'ses_abc123', nextAction: 'Resume the exact provider session',
  } }), true);
  const checkpoint = await memory.read(repo, issue);
  assert.equal(checkpoint.lastSessionId, 'linear-session-1');
  assert.equal(checkpoint.lastProviderSessionId, 'ses_abc123');
  assert.match(memory.recoveryPreamble(checkpoint), /Previous provider session: ses_abc123/);
}));

test('OpenCode progress is bounded, redacted, and attached to the active job', async () => fixture(async ({ memory, jobStore, repo, issue }) => {
  assert.equal(await recordOpenCodeProgress({ jobStore, memory, jobKey: 'job-current', summary: 'Tool completed with api_key=supersecret' }), true);
  const checkpoint = await memory.read(repo, issue);
  assert.equal(checkpoint.progress.length, 1);
  assert.match(checkpoint.progress[0].summary, /api_key=\[REDACTED\]/);
  assert.equal(checkpoint.progress[0].summary.includes('supersecret'), false);
  assert.equal(checkpoint.progress[0].jobKey, 'job-current');
}));

test('late OpenCode events from an older job cannot overwrite a newer issue checkpoint', async () => fixture(async ({ memory, jobStore, repo, issue }) => {
  await memory.update(repo, issue, { lastJobKey: 'job-newer', nextAction: 'Newer task owns this checkpoint' });
  assert.equal(await updateOpenCodeCheckpoint({ jobStore, memory, jobKey: 'job-current', patch: {
    lastProviderSessionId: 'ses_old', state: 'agent-finished',
  } }), false);
  assert.equal(await recordOpenCodeProgress({ jobStore, memory, jobKey: 'job-current', summary: 'stale progress' }), false);
  const checkpoint = await memory.read(repo, issue);
  assert.equal(checkpoint.lastJobKey, 'job-newer');
  assert.equal(checkpoint.nextAction, 'Newer task owns this checkpoint');
  assert.equal(checkpoint.lastProviderSessionId, null);
  assert.equal(checkpoint.progress.length, 0);
}));

test('OpenCode completion is recorded as agent-finished, not independently verified success', async () => fixture(async ({ memory, jobStore, repo, issue }) => {
  await updateOpenCodeCheckpoint({ jobStore, memory, jobKey: 'job-current', patch: {
    state: 'agent-finished',
    lastVerifiedResult: 'OpenCode returned a final response; tests remain independently unverified',
    nextAction: 'Verify diff and tests',
  } });
  const checkpoint = await memory.read(repo, issue);
  assert.equal(checkpoint.status, 'completed');
  assert.match(checkpoint.lastVerifiedResult, /tests remain independently unverified/);
  assert.equal(checkpoint.nextAction, 'Verify diff and tests');
}));
