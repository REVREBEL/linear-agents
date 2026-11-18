import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProcessLifecycleReporter } from './process-lifecycle.mjs';

function child() {
  const process = new EventEmitter();
  process.pid = 42;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  return process;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('subprocess spawn and close mirror only after ledger commits', async () => {
  const transitions = [], mirrors = [];
  const jobStore = { transition: async (key, state, data) => { transitions.push({key,state,data}); } };
  const attach = createProcessLifecycleReporter({ jobStore, onTransition: async (key,state) => mirrors.push(state), logger: { log() {}, error() {} } });
  const proc = child();
  attach(proc, 'Gemini', 'job');
  proc.emit('spawn'); await flush();
  proc.emit('close', 0, null); await flush();
  assert.deepEqual(mirrors, ['running','completed']);
  assert.deepEqual(transitions.map(x=>x.state), mirrors);
});

test('spawn failure records failed and does not report successful close', async () => {
  const states = [];
  const attach = createProcessLifecycleReporter({ jobStore: { transition: async (_key,state) => { states.push(state); } }, logger: { log() {}, error() {} } });
  const proc = child(); attach(proc, 'Trae', 'job');
  proc.emit('error', new Error('launch refused'));
  proc.emit('close', 0, null);
  await flush();
  assert.deepEqual(states, ['failed']);
});

test('checkpoint hook failure cannot change successful ledger transition', async () => {
  const states = [];
  const attach = createProcessLifecycleReporter({ jobStore: { transition: async (_key,state) => { states.push(state); } }, onTransition: async () => { throw Error('memory unavailable'); }, logger: { log() {}, error() {}, warn() {} } });
  const proc = child(); attach(proc, 'Gemini', 'job');
  proc.emit('spawn'); await flush();
  assert.deepEqual(states, ['running']);
});
