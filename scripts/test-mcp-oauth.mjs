// ABR-95: local-only OAuth resource-bound MCP and protocol regression tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResourceAuthorizer } from '../bridge/server/mcp-relay/oauth-resource.mjs';
import { MODERN } from '../bridge/server/mcp-relay/protocol-compat.mjs';
import { createLocalMcpRelay } from '../bridge/server/mcp-relay/index.mjs';
import { connectLocalHostAgent } from '../bridge/agent/mcp-host-agent/index.mjs';
import { createLocalPkceIssuerFixture } from './fixtures/oauth-local-issuer.mjs';

const issuerUrl = 'https://test-idp.example.invalid';
const resourceUrl = 'https://mcp-bridge.revrebel.io/mcp';
const redirect = 'https://chatgpt.com/connector/oauth/fixture-only';
const deviceId = 'oauth-test-host';
const agentToken = 'paired-agent-' + 'x'.repeat(58);
const user = 'reviewer@example.invalid';
const secret = 'v'.repeat(64);
const challenge = createHash('sha256').update(secret).digest('base64url');
const state = 'local-state-' + 's'.repeat(40);
const now = () => 1_850_000_000;

function claims({ clientId, scope = 'mcp:discover mcp:read', ...overrides }) {
  return {
    iss: issuerUrl, aud: [resourceUrl], sub: user, client_id: clientId,
    scope, jti: 'test-jti-' + 'z'.repeat(36), iat: now(),
    nbf: now(), exp: now() + 300, ...overrides,
  };
}
function meta(method, name) {
  return {
    ...((name && method === 'tools/call') ? { 'Mcp-Name': name } : {}),
    'Mcp-Method': method,
    'MCP-Protocol-Version': MODERN,
  };
}
function modern(method, params = {}) {
  return {
    jsonrpc: '2.0', id: 21, method,
    params: { ...params, _meta: {
      ...params._meta,
      'io.modelcontextprotocol/protocolVersion': MODERN,
      'io.modelcontextprotocol/clientInfo': { name: 'local-test-client', version: '1.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } },
  };
}

test('ABR-95 offline PKCE/OIDC issuer has resource-bound, redirect-locked, rotating grants', async t => {
  const provider = createLocalPkceIssuerFixture({
    issuer: issuerUrl, resource: resourceUrl, allowedRedirects: [redirect], now,
  });
  const client = provider.registerClient({ redirectUris: [redirect] });
  assert.equal(provider.metadata().issuer, issuerUrl);
  assert.deepEqual(provider.metadata().code_challenge_methods_supported, ['S256']);
  assert.ok(provider.metadata().scopes_supported.includes('offline_access'));
  await t.test('dynamic registration rejects unauthorized redirects', () => {
    assert.throws(() => provider.registerClient({
      redirectUris: ['https://malicious.invalid/callback'],
    }), /REDIRECT_NOT_REGISTERABLE/);
  });
  const auth = {
    clientId: client.client_id, redirectUri: redirect, state,
    codeChallenge: challenge, scope: 'mcp:discover mcp:read offline_access',
    approved: true,
  };
  await t.test('S256, explicit approval, CSRF state, audience and redirect all enforced', () => {
    assert.throws(() => provider.authorize({ ...auth, approved: false }), /CONSENT_REQUIRED/);
    assert.throws(() => provider.authorize({ ...auth, state: 's' }), /CSRF_STATE_REQUIRED/);
    assert.throws(() => provider.authorize({ ...auth, method: 'plain' }), /PKCE_S256_REQUIRED/);
    assert.throws(() => provider.authorize({ ...auth,
      redirectUri: 'https://malicious.invalid/callback' }), /REDIRECT_MISMATCH/);
    assert.throws(() => provider.authorize({ ...auth,
      requestedResource: 'https://another.invalid/mcp' }), /WRONG_RESOURCE/);
    assert.throws(() => provider.authorize({ ...auth, scope: 'mcp:admin' }), /SCOPE_NOT_ALLOWED/);
  });
  await t.test('authorization code is single-use; wrong PKCE/redirect/resource fail closed', () => {
    const approval = provider.authorize(auth);
    assert.equal(approval.state, state);
    assert.equal(approval.iss, issuerUrl);
    const redeem = { clientId: client.client_id, redirectUri: redirect,
      code: approval.code, codeVerifier: secret };
    assert.throws(() => provider.exchangeCode({ ...redeem, codeVerifier: 'bad' }), /INVALID_GRANT/);
    assert.throws(() => provider.exchangeCode({ ...redeem,
      requestedResource: 'https://another.invalid/mcp' }), /INVALID_GRANT/);
    assert.throws(() => provider.exchangeCode({ ...redeem,
      redirectUri: 'https://malicious.invalid/callback' }), /INVALID_GRANT/);
    const tokens = provider.exchangeCode(redeem);
    assert.ok(tokens.access_token.includes('.'));
    assert.throws(() => provider.exchangeCode(redeem), /INVALID_GRANT/);
    const rotated = provider.refresh({ clientId: client.client_id,
      refreshToken: tokens.refresh_token });
    assert.notEqual(tokens.refresh_token, rotated.refresh_token);
    assert.notEqual(tokens.access_token, rotated.access_token);
    assert.throws(() => provider.refresh({ clientId: client.client_id,
      refreshToken: tokens.refresh_token }), /INVALID_GRANT/);
    provider.revoke(rotated.access_token);
    assert.equal(provider.revoked.size, 1);
  });
});

test('ABR-95 signed resource-server tokens protect the paired MCP device', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'abr95-oauth-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'README.md'), '# Authorized source\n');
  const provider = createLocalPkceIssuerFixture({
    issuer: issuerUrl, resource: resourceUrl, allowedRedirects: [redirect], now,
  });
  const clientId = provider.registerClient({ redirectUris: [redirect] }).client_id;
  const authorizer = createResourceAuthorizer({
    issuer: issuerUrl, audience: resourceUrl, jwks: provider.jwks,
    revoked: provider.revoked, now,
    grants: { [user]: {
      devices: [deviceId], clients: [clientId],
      tools: ['tools/list', 'list_devices', 'read_file'],
    } },
  });
  const good = provider.signClaimsForTest(claims({ clientId }));
  const relay = createLocalMcpRelay({ oauthResource: authorizer, agentToken, deviceId });
  let agent;
  const addr = await relay.listen();
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/agent`;
  async function request(method, params = {}, options = {}) {
    const payload = options.modern === false ? { jsonrpc: '2.0', id: 31, method, params }
      : modern(method, params);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(options.token === null ? {} : { Authorization: `Bearer ${options.token ?? good}` }),
      ...(options.modern === false ? (options.legacyVersion
        ? { 'MCP-Protocol-Version': options.legacyVersion } : {}) :
        meta(method, params?.name)),
      ...options.headers,
    };
    const response = await fetch(url, { method: 'POST',
      headers, body: JSON.stringify(options.body ?? payload) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  try {
    agent = await connectLocalHostAgent({ endpoint: wsUrl, agentToken, deviceId,
      workspace });
    await t.test('protected-resource metadata is public but not a tool entrypoint', async () => {
      const response = await fetch(`http://127.0.0.1:${addr.port}/.well-known/oauth-protected-resource`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), authorizer.protectedMetadata());
      const alternate = await fetch(`http://127.0.0.1:${addr.port}/.well-known/oauth-protected-resource/mcp`);
      assert.equal(alternate.status, 200);
      const missing = await request('tools/list', {}, { token: null });
      assert.equal(missing.status, 401);
      assert.match(missing.headers.get('www-authenticate'), /resource_metadata=/);
      assert.equal(missing.body.error, 'UNAUTHORIZED');
    });
    await t.test('modern stateless discover, list and tool calls use pinned request metadata', async () => {
      const discovered = await request('server/discover');
      assert.equal(discovered.status, 200);
      assert.deepEqual(discovered.body.result.supportedVersions,
        [MODERN, '2025-11-25', '2025-06-18']);
      assert.equal(discovered.body.result._meta['io.modelcontextprotocol/serverInfo'].name,
        'revrebel-mcp-local-foundation');
      assert.equal(discovered.body.result.cacheScope, 'private');
      assert.equal(discovered.body.result.resultType, 'complete');
      const listed = await request('tools/list');
      assert.deepEqual(listed.body.result.tools.map(t => t.name), ['list_devices', 'read_file']);
      assert.equal(listed.body.result.ttlMs, 0);
      const result = await request('tools/call', {
        name: 'read_file', arguments: { deviceId, path: 'README.md' },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.result.isError, false);
      assert.equal(result.body.result.resultType, 'complete');
      assert.equal(JSON.parse(result.body.result.content[0].text).content, '# Authorized source\n');
    });
    await t.test('legacy initialize and tool call require the same OAuth authorization', async () => {
      const legacy = await request('initialize', { protocolVersion: '2025-11-25' },
        { modern: false, legacyVersion: '2025-11-25' });
      assert.equal(legacy.status, 200);
      assert.equal(legacy.body.result.protocolVersion, '2025-11-25');
      const listed = await request('tools/list', {},
        { modern: false, legacyVersion: '2025-11-25' });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.result.tools.length, 2);
      const denied = await request('tools/call', { name: 'read_file',
        arguments: { deviceId, path: 'README.md' } },
      { modern: false, legacyVersion: '2025-11-25', token: null });
      assert.equal(denied.status, 401);
    });
    await t.test('modern transport rejects spoofed/missing headers and mismatched body', async () => {
      const wrongMethod = await request('tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } });
      assert.equal(wrongMethod.status, 400);
      assert.equal(wrongMethod.body.error.code, -32020);
      const missingVersion = await request('tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } });
      assert.equal(missingVersion.status, 400);
      assert.equal(missingVersion.body.error.code, -32020);
      const wrongName = await request('tools/call', { name: 'read_file',
        arguments: { deviceId, path: 'README.md' } },
      { headers: { 'Mcp-Name': 'delete_file' } });
      assert.equal(wrongName.body.error.code, -32020);
      const badLegacy = await request('initialize', { protocolVersion: '2027-01-01' },
        { modern: false, legacyVersion: '2027-01-01' });
      assert.equal(badLegacy.body.error.code, -32022);
      const unknownBody = modern('server/discover');
      unknownBody.params._meta['io.modelcontextprotocol/protocolVersion'] = '2027-01-01';
      const unknownModern = await request('server/discover', {}, {
        headers: { 'MCP-Protocol-Version': '2027-01-01' },
        body: unknownBody,
      });
      assert.equal(unknownModern.status, 400);
      assert.equal(unknownModern.body.error.code, -32022);
      assert.ok(unknownModern.body.error.data.supported.includes(MODERN));
      const noModernInit = await request('initialize', { protocolVersion: MODERN });
      assert.equal(noModernInit.body.error.code, -32601);
      assert.equal(noModernInit.status, 404);
      const rejectProxy = await request('tools/list', {}, {
        headers: { 'X-Forwarded-Host': 'mcp-bridge.revrebel.io' },
      });
      assert.equal(rejectProxy.status, 403);
      assert.equal(rejectProxy.body.error, 'UNTRUSTED_PROXY_HEADERS');
      const noSessionPrivilege = await request('tools/list', {}, {
        headers: { 'Mcp-Session-Id': 'injected-session' },
      });
      assert.equal(noSessionPrivilege.status, 200);
      assert.equal(noSessionPrivilege.body.result.tools.length, 2);
    });
    await t.test('exact issuer, audience, expiry, algorithm and IDP signature required', async () => {
      const alternate = [
        { iss: 'https://forged-idp.invalid' },
        { aud: ['https://wrong-resource.invalid/mcp'] },
        { exp: now() - 1 },
        { nbf: now() + 1000 },
        { scope: 'mcp:admin' },
        { sub: 'attacker@example.invalid' },
        { client_id: 'unapproved-client' },
        { jti: 'short' },
      ];
      for (const overrides of alternate) {
        const token = provider.signClaimsForTest(claims({ clientId, ...overrides }));
        const result = await request('tools/list', {}, { token });
        const insufficient = Object.hasOwn(overrides, 'scope')
          || Object.hasOwn(overrides, 'sub') || Object.hasOwn(overrides, 'client_id');
        assert.equal(result.status, insufficient ? 403 : 401, JSON.stringify(overrides));
      }
      const modified = good.slice(0, -5) + 'abcde';
      assert.equal((await request('tools/list', {}, { token: modified })).status, 401);
    });
    await t.test('scopes, server-owned tool permissions, and exact device grants rechecked', async () => {
      const readOnly = provider.signClaimsForTest(claims({
        clientId, scope: 'mcp:read',
      }));
      const scopeDenied = await request('tools/list', {}, { token: readOnly });
      assert.equal(scopeDenied.status, 403);
      assert.equal(scopeDenied.body.error, 'INSUFFICIENT_SCOPE');
      assert.match(scopeDenied.headers.get('www-authenticate'), /insufficient_scope/);
      const discoverOnly = provider.signClaimsForTest(claims({
        clientId, scope: 'mcp:discover',
      }));
      const catalog = await request('tools/list', {}, { token: discoverOnly });
      assert.deepEqual(catalog.body.result.tools.map(t => t.name), ['list_devices']);
      const denied = await request('tools/call', {
        name: 'read_file', arguments: { deviceId, path: 'README.md' },
      }, { token: discoverOnly });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, 'INSUFFICIENT_SCOPE');
      const wrongDevice = await request('tools/call', {
        name: 'read_file', arguments: { deviceId: 'another-host', path: 'README.md' },
      });
      assert.equal(wrongDevice.status, 403);
      assert.equal(wrongDevice.body.error, 'DEVICE_NOT_AUTHORIZED');
      const unlisted = await request('tools/call', {
        name: 'delete_file', arguments: { deviceId, path: 'README.md' },
      });
      assert.equal(unlisted.body.result.isError, true);
    });
    await t.test('token revocation takes effect immediately, including across protocol eras', async () => {
      provider.revoke(good);
      assert.equal((await request('tools/list')).status, 401);
      const legacy = await request('tools/list', {},
        { modern: false, legacyVersion: '2025-11-25' });
      assert.equal(legacy.status, 401);
      assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'),
        '# Authorized source\n');
    });
  } finally {
    await agent?.close();
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});
