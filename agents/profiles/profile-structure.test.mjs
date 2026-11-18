import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('research YAML profiles remain separate from executable worker packages', () => {
  const dir = new URL('agents/profiles/candidates/', root);
  const profiles = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
  assert.equal(profiles.length, 14);
  for (const name of profiles) assert.ok(readFileSync(new URL(name, dir), 'utf8').trim(), name);
});

test('canonical registry and its worker package paths are intact', () => {
  const registry = JSON.parse(read('agents/registry.json'));
  assert.equal(registry.schemaVersion, 2);
  assert.equal(registry.agents.length, 7);
  for (const agent of registry.agents) {
    assert.ok(existsSync(new URL(agent.packageDir + '/', root)), agent.packageDir);
    if (agent.worker?.directory) assert.ok(existsSync(new URL(agent.worker.directory + '/', root)), agent.worker.directory);
  }
});
