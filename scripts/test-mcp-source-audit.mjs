// ABR-94 immutable source-pin and tool-parity contract checks; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (name) => JSON.parse(await readFile(resolve(root, name), 'utf8'));
const baseline = new Set([
  'list_devices', 'who_am_i', 'get_tool_result', 'list_remote_tool_calls', 'shutdown',
  'get_config', 'set_config_value', 'read_file', 'read_multiple_files', 'write_file',
  'write_pdf', 'create_directory', 'list_directory', 'move_file',
  'start_search', 'get_more_search_results', 'stop_search', 'list_searches',
  'get_file_info', 'edit_block', 'start_process', 'read_process_output',
  'interact_with_process', 'force_terminate', 'list_sessions', 'list_processes',
  'kill_process', 'get_usage_stats', 'get_recent_tool_calls', 'review_device_call',
]);
const rejected = new Set(['prepare_file_transfer', 'send_file_transfer', 'receive_file_transfer']);
const pluginTools = new Set([
  'list_plugin_tools', 'call_plugin_tool', 'search_mcp_registry', 'request_plugin_install',
]);
test('source pins are full immutable commits with file-level Git provenance', async () => {
  const lock = await read('docs/audits/mcp/upstream-lock.json');
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.sources.length, 2);
  assert.deepEqual(lock.sources.map((x) => x.repo), [
    'shahidx0x/better-remote-commander', 'wonderwhy-er/DesktopCommanderMCP',
  ]);
  for (const source of lock.sources) {
    assert.match(source.commitSha, /^[0-9a-f]{40}$/);
    assert.match(source.license, /MIT/);
    assert.ok(source.reviewedFiles.length >= 3);
    const paths = source.reviewedFiles.map((x) => x.path);
    assert.ok(paths.includes('LICENSE'));
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.some((x) => x.includes('lock')));
    for (const file of source.reviewedFiles) {
      assert.match(file.blobSha, /^[0-9a-f]{40}$/);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(file.bytes > 0);
    }
  }
  assert.equal(lock.portArchitecture.vendorStatus, 'no direct upstream code vendored');
});
test('all 30 connected, 42 BRC agent and 3 relay tool names have dispositions', async () => {
  const contract = await read('docs/audits/mcp/tool-parity.json');
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.counts, {
    connected: 30, brcAgent: 42, brcRelay: 3,
    sharedConnectedAndBrcAgent: 24, connectedUniqueNotBrcAgent: 6,
    brcAgentUniqueNotConnected: 18, distinctToolNames: 50,
  });
  const rows = contract.tools;
  assert.equal(rows.length, 50);
  assert.equal(new Set(rows.map((x) => x.name)).size, 50);
  assert.deepEqual(new Set(rows.filter((x) => x.connectedRemoteDesktopCommander).map((x) => x.name)), baseline);
  assert.equal(rows.filter((x) => x.brcAgent42).length, 42);
  assert.equal(rows.filter((x) => x.brcRelay3).length, 3);
  assert.equal(rows.filter((x) => x.brcAgent42 && x.connectedRemoteDesktopCommander).length, 24);
  for (const item of rows) {
    assert.ok(item.approvedDisposition && item.testId && item.furtherOwner);
    assert.ok(item.category !== 'unclassified', item.name);
    if (item.connectedRemoteDesktopCommander) {
      assert.ok(item.registeredInputSignature?.includes(item.name), item.name);
    }
    if (rejected.has(item.name)) assert.equal(item.approvedDisposition, 'reject_no_transport');
    if (pluginTools.has(item.name)) assert.equal(item.approvedDisposition, 'deny_pending_explicit_plugin_approval');
    if (item.abr94Foundation === 'implemented_in_ABR94_local_smoke') {
      assert.ok(['read_file', 'list_devices'].includes(item.name));
    }
  }
  assert.equal(rows.find((x) => x.name === 'write_pdf').connectedRemoteDesktopCommander, true);
  assert.equal(rows.some((x) => x.name === 'read_pdf'), false);
});
test('read-only foundation does not register privileged or external tool handlers', async () => {
  const content = await readFile(resolve(root, 'bridge/server/mcp-relay/index.mjs'), 'utf8');
  const host = await readFile(resolve(root, 'bridge/agent/mcp-host-agent/index.mjs'), 'utf8');
  const opener = await readFile(resolve(root, 'bridge/agent/mcp-host-agent/safe-read.mjs'), 'utf8');
  for (const name of [...rejected, ...pluginTools]) {
    assert.ok(!content.includes(`name: '${name}'`), name);
  }
  assert.ok(!/https:\/\//.test(content + host + opener));
  assert.ok(!/tmpfiles\.org|supabase|mcp\.desktopcommander\.app/i.test(content + host + opener));
  assert.ok(!/\bspawn\s*\(|\bexec\s*\(/.test(content + host + opener));
});
