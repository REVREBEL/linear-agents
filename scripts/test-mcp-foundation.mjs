import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createLocalMcpRelay } from '../bridge/server/mcp-relay/index.mjs';
import { connectLocalHostAgent } from '../bridge/agent/mcp-host-agent/index.mjs';

const clientToken = 'client-' + '1'.repeat(60);
const agentToken = 'agent-' + '2'.repeat(60);
const deviceId = 'rebel-test';
const restrictedTools = [
  'write_file', 'edit_block', 'run_command', 'shutdown', 'delete_file',
  'spawn_job', 'send_file_transfer', 'receive_file_transfer',
  'prepare_file_transfer', 'list_plugin_tools', 'call_plugin_tool',
  'search_mcp_registry', 'request_plugin_install', 'submit_work',
];

test('ABR-94 local relay+agent: authenticate, pair, read and fail closed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'abr94-mcp-'));
  const inside = path.join(root, 'workspace');
  await mkdir(inside);
  await writeFile(path.join(inside, 'README.md'), '# First line\nSecond line\n', 'utf8');
  await writeFile(path.join(inside, 'large.txt'), 'Z'.repeat(90_000), 'utf8');
  await writeFile(path.join(inside, 'too-large.txt'), 'Y'.repeat(263_000), 'utf8');
  await writeFile(path.join(inside, 'control.txt'), '\0'.repeat(120_000), 'utf8');
  if (process.platform !== 'win32') execFileSync('mkfifo', [path.join(inside, 'pipe')]);
  await writeFile(path.join(root, 'outside.txt'), 'OUTSIDE_SECRET', 'utf8');
  await symlink(path.join(root, 'outside.txt'), path.join(inside, 'outside-link'));
  await symlink(path.join(inside, 'README.md'), path.join(inside, 'inside-link'));
  const relay = createLocalMcpRelay({ clientToken, agentToken, deviceId });
  let agent;
  const address = await relay.listen();
  assert.equal(address.address, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const wsUrl = `ws://127.0.0.1:${address.port}/agent`;
  let nextId = 1;
  async function call(method, params = {}, options = {}) {
    const body = { jsonrpc: '2.0', id: nextId++, method, params };
    const response = await fetch(options.url ?? url, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(options.token === null ? {} : { Authorization: 'Bearer ' + (options.token ?? clientToken) }),
        ...(options.origin ? { Origin: options.origin } : {}) },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    return { status: response.status, result, response };
  }
  async function tool(name, args = {}) {
    return (await call('tools/call', { name, arguments: args })).result;
  }
  try {
    await t.test('listener is loopback and unauthenticated MCP is denied', async () => {
      assert.equal((await call('initialize', {}, { token: null })).status, 401);
      assert.equal((await call('tools/list', {}, { token: 'bad' })).status, 401);
      const spoof = await call('tools/list', {}, { origin: 'https://malicious.example' });
      assert.equal(spoof.status, 403);
    });
    await t.test('MCP initialization, JSON-RPC and tool discovery', async () => {
      const init = await call('initialize', { protocolVersion: '2025-06-18',
        capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
      assert.equal(init.status, 200);
      assert.equal(init.result.result.protocolVersion, '2025-06-18');
      const listing = await call('tools/list');
      assert.deepEqual(listing.result.result.tools.map((x) => x.name),
        ['list_devices', 'read_file']);
      const names = JSON.stringify(listing.result);
      assert.ok(!restrictedTools.some((name) => names.includes('"' + name + '"')));
      assert.equal((await call('initialize', { protocolVersion: '9999-01-01' })).result.error.code, -32602);
      assert.equal((await call('unknown')).result.error.code, -32601);
    });
    await t.test('relay refuses private URL capabilities and marketplace/install endpoints', async () => {
      for (const suffix of ['/c/unapproved/mcp', '/admin', '/marketplace', '/plugins']) {
        const response = await call('tools/list', {}, { url: `http://127.0.0.1:${address.port}${suffix}` });
        assert.equal(response.status, 404, suffix);
      }
    });
    await t.test('wrong pairing secrets and device identifiers are rejected', async () => {
      for (const headers of [
        { Authorization: 'Bearer bad', 'X-Agent-Device': deviceId },
        { Authorization: 'Bearer ' + agentToken, 'X-Agent-Device': 'other-host' },
      ]) {
        const status = await new Promise((resolve) => {
          const attempt = new WebSocket(wsUrl, [], { headers });
          attempt.on('unexpected-response', (_req, response) => {
            const code = response.statusCode;
            response.resume(); attempt.terminate(); resolve(code);
          });
          attempt.on('error', () => {});
        });
        assert.equal(status, 401);
      }
    });
    await t.test('ambiguous localhost agent hostname fails before DNS connection', async () => {
      await assert.rejects(connectLocalHostAgent({
        endpoint: `ws://localhost:${address.port}/agent`,
        agentToken, deviceId, workspace: inside,
      }), /Only the local loopback agent endpoint/);
    });
    await t.test('pair a local agent and read exact authorized file content', async () => {
      agent = await connectLocalHostAgent({ endpoint: wsUrl, agentToken, deviceId,
        workspace: inside });
      const visible = await tool('list_devices');
      assert.equal(JSON.parse(visible.result.content[0].text)[0].online, true);
      const result = await tool('read_file', { deviceId, path: 'README.md', offset: 0, length: 2 });
      assert.equal(result.result.isError, false);
      const body = JSON.parse(result.result.content[0].text);
      assert.equal(body.content, '# First line\nSecond line');
      assert.equal(body.sha256, createHash('sha256').update('# First line\nSecond line\n').digest('hex'));
      const absolute = await tool('read_file', { deviceId, path: path.join(inside, 'README.md') });
      assert.equal(absolute.result.isError, false);
      const insideLink = await tool('read_file', { deviceId, path: 'inside-link' });
      assert.equal(insideLink.result.isError, false);
    });
    await t.test('large bounded reads survive WebSocket framing; oversized files fail closed', async () => {
      const large = await tool('read_file', { deviceId, path: 'large.txt', length: 1 });
      assert.equal(large.result.isError, false);
      assert.equal(JSON.parse(large.result.content[0].text).content.length, 90_000);
      const blocked = await tool('read_file', { deviceId, path: 'too-large.txt' });
      assert.equal(blocked.result.isError, true);
      assert.equal(blocked.result.content[0].text, 'FILE_TOO_LARGE');
    });
    await t.test('control-character JSON amplification returns a bounded error without disconnect', async () => {
      const rejected = await tool('read_file', { deviceId, path: 'control.txt', length: 1 });
      assert.equal(rejected.result.isError, true);
      assert.equal(rejected.result.content[0].text, 'RESULT_TOO_LARGE');
      const afterwards = await tool('read_file', { deviceId, path: 'README.md' });
      assert.equal(afterwards.result.isError, false);
    });
    await t.test('FIFO has no writer but is rejected without blocking a host worker', async () => {
      if (process.platform === 'win32') return;
      const rejected = await tool('read_file', { deviceId, path: 'pipe' });
      assert.equal(rejected.result.isError, true);
      assert.equal(rejected.result.content[0].text, 'NOT_A_REGULAR_FILE');
    });
    await t.test('reject wrong device, traversal, absolute path and symlink escape', async () => {
      const wrong = await tool('read_file', { deviceId: 'unauthorized', path: 'README.md' });
      assert.match(wrong.result.content[0].text, /DEVICE_NOT_AUTHORIZED/);
      for (const file of ['../outside.txt', path.join(root, 'outside.txt'), 'outside-link']) {
        const outcome = await tool('read_file', { deviceId, path: file });
        assert.equal(outcome.result.isError, true, file);
        assert.match(outcome.result.content[0].text, /OUTSIDE_AUTHORIZED_WORKSPACE/, file);
      }
    });
    await t.test('reject malformed paths, huge payloads and unknown tools at invocation', async () => {
      for (const args of [{ deviceId, path: '' }, { deviceId, path: 'README.md', length: -1 },
        { deviceId, path: 'README.md', privileges: 'admin' }]) {
        assert.equal((await tool('read_file', args)).error.code, -32602);
      }
      for (const name of restrictedTools) {
        const denied = await tool(name, { deviceId, path: 'README.md' });
        assert.equal(denied.result.isError, true, name);
        assert.equal(denied.result.content[0].text, 'UNKNOWN_OR_UNAUTHORIZED_TOOL', name);
      }
    });
    await t.test('core, focused and full tool discovery never bypass direct-call permissions', async () => {
      for (const profile of ['core', 'focused', 'full']) {
        const service = createLocalMcpRelay({ clientToken, agentToken, deviceId, profile });
        const addr = await service.listen();
        const endpoint = `http://127.0.0.1:${addr.port}/mcp`;
        try {
          const send = async (method, params = {}) => {
            const response = await fetch(endpoint, { method: 'POST',
              headers: { Authorization: 'Bearer ' + clientToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 100 }),
            });
            return response.json();
          };
          const listing = await send('tools/list');
          assert.deepEqual(listing.result.tools.map((x) => x.name), ['list_devices', 'read_file']);
          for (const name of ['write_file', 'delete_file', 'call_plugin_tool', 'submit_work']) {
            const attempt = await send('tools/call', { name, arguments: { deviceId, path: 'README.md' } });
            assert.equal(attempt.result.isError, true, `${profile}: ${name}`);
          }
        } finally { await service.close(); }
      }
    });
    await t.test('bad request format and untrusted HTTP origins cannot reach the host', async () => {
      const request = await fetch(url, { method: 'POST',
        headers: { Authorization: 'Bearer ' + clientToken, 'Content-Type': 'text/plain' },
        body: 'not JSON' });
      assert.equal(request.status, 415);
      const denied = await call('tools/call', { name: 'read_file',
        arguments: { deviceId, path: 'README.md' } }, { token: null });
      assert.equal(denied.status, 401);
    });
    await t.test('oversized paired WebSocket frames disconnect safely without process crash', async () => {
      const disconnected = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Expected oversized device frame to close')), 3_000);
        agent.socket.once('close', () => { clearTimeout(timeout); resolve(); });
      });
      agent.socket.send('X'.repeat(1_100_000));
      await disconnected;
      const rejected = await tool('read_file', { deviceId, path: 'README.md' });
      assert.equal(rejected.result.isError, true);
      assert.equal(rejected.result.content[0].text, 'DEVICE_OFFLINE');
    });
    await t.test('disconnect does not create Linear job state or authorize subsequent reads', async () => {
      await agent.close();
      const denied = await tool('read_file', { deviceId, path: 'README.md' });
      assert.equal(denied.result.isError, true);
      assert.equal(denied.result.content[0].text, 'DEVICE_OFFLINE');
      assert.deepEqual(await readFile(path.join(inside, 'README.md'), 'utf8'), '# First line\nSecond line\n');
    });
    await t.test('host handles a malicious oversized relay frame without crashing', async () => {
      const fakeRelay = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
      await new Promise((resolve) => fakeRelay.once('listening', resolve));
      const serverPeer = new Promise((resolve) => fakeRelay.once('connection', resolve));
      const standalone = await connectLocalHostAgent({
        endpoint: `ws://127.0.0.1:${fakeRelay.address().port}/agent`,
        agentToken, deviceId: 'independent-host', workspace: inside,
      });
      const peer = await serverPeer;
      try {
        const closed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Host failed to close oversized frame')), 3_000);
          standalone.socket.once('close', () => { clearTimeout(timer); resolve(); });
        });
        peer.send('X'.repeat(300_000));
        await closed;
        assert.equal(standalone.socket.readyState, WebSocket.CLOSED);
      } finally {
        peer.terminate();
        await standalone.close();
        await new Promise((resolve) => fakeRelay.close(resolve));
      }
    });
    await t.test('source contains no third-party egress, tools or process invocations', async () => {
      const sources = [
        '../bridge/server/mcp-relay/index.mjs', '../bridge/agent/mcp-host-agent/index.mjs',
      ];
      for (const source of sources) {
        const content = await readFile(new URL(source, import.meta.url), 'utf8');
        assert.doesNotMatch(content, /https:\/\//);
        assert.doesNotMatch(content, /tmpfiles\.org|mcp\.desktopcommander\.app|supabase|spawn\(|exec\(/i);
      }
    });
  } finally {
    await agent?.close();
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});
