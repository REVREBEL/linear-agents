// ABR-98 profile/schema/security tests: all tools exercised here are
// explicitly injected fixtures, not production command implementations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createMcpToolProfiles, measureToolProfileFootprint,
  PARITY_COUNTS, TOOL_NAMES } from '../bridge/server/mcp-relay/tool-profiles.mjs';
import { createLocalMcpRelay } from '../bridge/server/mcp-relay/index.mjs';
import { createResourceAuthorizer } from '../bridge/server/mcp-relay/oauth-resource.mjs';
import { createLocalPkceIssuerFixture } from './fixtures/oauth-local-issuer.mjs';
import { MODERN } from '../bridge/server/mcp-relay/protocol-compat.mjs';
import { analyzeProcessState } from '../bridge/agent/mcp-host-agent/process-state.mjs';

const SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: false };
const deviceId = 'abr98-local-host';
const allow = Object.freeze({ 'fixture': true });
const base = {
  subject: 'tester@example.invalid', tenantId: 'tenant-one',
  sessionId: 'session-001', deviceId, expiresAt: 5_000_000,
  allowedTools: ['list_devices','read_file','git_status','write_pdf','set_config_value'],
  capabilities: ['workspace:read','workspace:write','process:execute','document:write','admin'],
  allowedWorkspaces: ['project'], profile: 'core',
};
const now = () => 4_999_000;
function catalog({ profile = 'core', allowedTools = base.allowedTools,
  capabilities = base.capabilities, handlers, allowAdmin = false, liveness = () => true } = {}) {
  const grant = { ...base, profile, allowedTools, capabilities };
  const credential = Object.freeze({});
  const gateway = createMcpToolProfiles({
    handlers: handlers ?? {
      list_devices: () => [{ id: deviceId }],
      read_file: () => ({ content: 'fixture source' }),
      git_status: () => ({ stdout: '## main' }),
      write_pdf: () => ({ mocked: true }),
    },
    schemas: { git_status: { type: 'object', properties: {
      workspaceId: { type: 'string' },
      deviceId: { type: 'string' },
    }, required: ['workspaceId'], additionalProperties: false } },
    verifySession: evidence => evidence === credential ? grant : null,
    checkLive: liveness, now, allowAdmin,
  });
  return { gateway, handle: gateway.register(credential), credential, grant };
}
test('ABR-98 pinned matrix reconciles exactly 30 connected, 42 agent and 3 relay tools', () => {
  assert.deepEqual([PARITY_COUNTS.connected, PARITY_COUNTS.brcAgent,
    PARITY_COUNTS.brcRelay, PARITY_COUNTS.distinctToolNames], [30,42,3,50]);
  assert.equal(new Set(TOOL_NAMES).size, 50);
  assert.ok(TOOL_NAMES.includes('write_pdf'));
  assert.ok(TOOL_NAMES.includes('get_recent_tool_calls'));
  assert.ok(TOOL_NAMES.includes('review_device_call'));
  assert.ok(TOOL_NAMES.includes('prepare_file_transfer'));
});
test('ABR-98 core / focused / full only disclose registered, granted handlers', () => {
  const core = catalog({ profile: 'core' });
  const focused = catalog({ profile: 'focused' });
  const full = catalog({ profile: 'full' });
  assert.deepEqual(core.gateway.listTools(core.handle).map(x=>x.name),
    ['list_devices','read_file']);
  assert.deepEqual(focused.gateway.listTools(focused.handle).map(x=>x.name),
    ['git_status','list_devices','read_file']);
  assert.deepEqual(full.gateway.listTools(full.handle).map(x=>x.name),
    ['git_status','list_devices','read_file','write_pdf']);
  assert.ok(full.gateway.inspect().unimplementedConnected.includes('write_file'));
  assert.ok(full.gateway.inspect().denied.includes('call_plugin_tool'));
  assert.ok(full.gateway.inspect().denied.includes('send_file_transfer'));
});
test('ABR-98 hidden exact-name invocation still requires independent capability', async () => {
  const core = catalog({ profile: 'core' });
  const hidden = await core.gateway.invoke(core.handle, 'git_status',
    { workspaceId:'project' });
  assert.equal(hidden.stdout, '## main');
  assert.deepEqual(await core.gateway.invoke(core.handle,'write_pdf',
    { path:'out.pdf', content:'# hello' }), { mocked: true });
});
test('ABR-98 document-write scope is independent from ordinary file writes', async () => {
  const granted = catalog({ profile: 'full',
    capabilities: ['workspace:read','workspace:write'] });
  assert.ok(!granted.gateway.listTools(granted.handle).some(t=>t.name==='write_pdf'));
  await assert.rejects(granted.gateway.invoke(granted.handle, 'write_pdf',
    { path:'out.pdf', content:'# hello' }), /TOOL_NOT_AUTHORIZED/);
  const allowed = catalog({ profile: 'full',
    capabilities: ['workspace:read','document:write'] });
  assert.deepEqual(await allowed.gateway.invoke(allowed.handle, 'write_pdf',
    { path:'out.pdf', content:'# hello' }), { mocked:true });
  assert.deepEqual(await allowed.gateway.invoke(allowed.handle, 'git_status',
    { workspaceId:'project' }), { stdout: '## main' });
});
test('ABR-98 privileged tools default deny even with handler; explicitly authorized hidden call works', async () => {
  assert.throws(()=>catalog({ handlers:{
    set_config_value: ()=>({ changed:true }),
  } }),/UNAPPROVED_TOOL_HANDLER/);
  const approved = catalog({ profile:'core', allowAdmin:true,
    handlers:{ set_config_value:()=>({ changed:true }) } });
  assert.deepEqual(approved.gateway.listTools(approved.handle),[]);
  assert.deepEqual(await approved.gateway.invoke(approved.handle,
    'set_config_value',{key:'theme',value:'dark'}),{changed:true});
  await assert.rejects(approved.gateway.invoke(approved.handle,
    'set_config_value',{key:'theme',value:'dark',unreviewed:'x'}),/INVALID_PARAMS/);
});
test('ABR-98 malformed arguments, forged sessions, device and workspace swaps fail', async () => {
  const {gateway,handle} = catalog();
  assert.throws(()=>gateway.register({}),/UNVERIFIED_TOOL_SESSION/);
  await assert.rejects(gateway.invoke({},'read_file',
    {deviceId,path:'file.txt'}),/UNAUTHORIZED_TOOL_SESSION/);
  await assert.rejects(gateway.invoke(handle,'read_file',
    {deviceId:'another-host',path:'file.txt'}),/TOOL_NOT_AUTHORIZED/);
  await assert.rejects(gateway.invoke(handle,'read_file',
    {deviceId,path:'file.txt',extra:'x'}),/INVALID_PARAMS/);
  await assert.rejects(gateway.invoke(handle,'git_status',
    {workspaceId:'not-approved'}),/TOOL_NOT_AUTHORIZED/);
  await assert.rejects(gateway.invoke(handle,'call_plugin_tool',{}),/TOOL_NOT_AUTHORIZED/);
  await assert.rejects(gateway.invoke(handle,'delete_file',{}),/TOOL_NOT_AUTHORIZED/);
  await assert.rejects(gateway.invoke(handle,'send_file_transfer',{}),/TOOL_NOT_AUTHORIZED/);
  assert.equal(gateway.revoke(handle),true);
  await assert.rejects(gateway.invoke(handle,'read_file',
    {deviceId,path:'file.txt'}),/UNAUTHORIZED_TOOL_SESSION/);
});
test('ABR-98 full discovery covers baseline names only when real adapters registered', async () => {
  const matrix = JSON.parse(readFileSync(new URL('../docs/audits/mcp/tool-parity.json',
    import.meta.url),'utf8'));
  const connected = matrix.tools.filter(t=>t.connectedRemoteDesktopCommander).map(t=>t.name);
  const handlers = Object.fromEntries(connected.map(t=>[t,()=>({success:true})]));
  const schemas = Object.fromEntries(connected.map(t=>[t,SCHEMA]));
  const credential = Object.freeze({});
  const gateway = createMcpToolProfiles({
    handlers, schemas, verifySession:x=>x===credential?{
      ...base, profile:'full', allowedTools:connected,
    }:null, now, allowAdmin:true,
  });
  const handle = gateway.register(credential);
  assert.deepEqual(gateway.listTools(handle).map(x=>x.name),connected.sort());
  assert.deepEqual(gateway.inspect().unimplementedConnected,[]);
  assert.deepEqual(await gateway.invoke(handle,'get_recent_tool_calls',{}),{success:true});
  // These were MOCK handlers: schema and behavior parity are not established
  // until independent real-agent golden fixtures and production adapters exist.
});
test('ABR-98 discovery benchmark measures bytes, token estimate and latency', () => {
  const marker=Object.freeze({});
  const gateway=createMcpToolProfiles({
    handlers:{
      list_devices:()=>[],read_file:()=>{},git_status:()=>{},write_pdf:()=>{},
    }, verifySession:credential=>credential?.marker===marker?{
      ...base, profile:credential.profile,
    }:null,now,
  });
  const handles=Object.fromEntries(['core','focused','full'].map(profile=>
    [profile,gateway.register({marker,profile})]));
  const footprint=measureToolProfileFootprint(gateway,handles,200);
  assert.ok(footprint.core.schemaBytes<footprint.focused.schemaBytes);
  assert.ok(footprint.focused.schemaBytes<footprint.full.schemaBytes);
  assert.ok(footprint.core.avgDiscoveryMs>=0);
  assert.ok(footprint.full.tokensApprox>footprint.core.tokensApprox);
  assert.deepEqual(Object.keys(footprint),['core','focused','full']);
});
test('ABR-98 deterministic prompt detection handles Python, pdb, mysql and shell without timing guesses', () => {
  for(const [prompt,text] of [
    ['python','>>> '],['python','... '],['pdb','(Pdb) '],
    ['mysql','mysql> '],['mysql','MariaDB [demo]> '],
    ['shell','user@server:~$ '],['shell','[root@box]# '],
  ]){
    const out=analyzeProcessState({stderr:'\u001b[32m'+text+'\u001b[0m'});
    assert.equal(out.status,'waiting_input',text);
    assert.equal(out.prompt,prompt,text);
  }
  assert.equal(analyzeProcessState({stdout:'running...\n'}).status,'running');
  assert.equal(analyzeProcessState({finished:true,exitCode:0}).status,'completed');
  assert.equal(analyzeProcessState({finished:true,exitCode:2}).status,'failed');
  assert.equal(analyzeProcessState({timedOut:true}).status,'timed_out');
  assert.equal(analyzeProcessState({cancelled:true}).status,'cancelled');
});

test('ABR-98 local OAuth relay: core discovery, authorized hidden PDF, and denied scope', async t => {
  const issuer = 'https://fixture-idp.invalid';
  const audience = 'https://mcp-test.revrebel.io/mcp';
  const at = () => 1_850_000_000;
  const provider = createLocalPkceIssuerFixture({
    issuer, resource: audience, allowedRedirects: ['https://chatgpt.com/oauth/fixture'],
    now: at,
  });
  const clientId = provider.registerClient({
    redirectUris: ['https://chatgpt.com/oauth/fixture'],
  }).client_id;
  const tools = ['tools/list', 'list_devices', 'read_file', 'write_pdf'];
  const authorizer = createResourceAuthorizer({
    issuer, audience, jwks: provider.jwks, revoked: provider.revoked,
    now: at,
    supportedScopes: ['mcp:discover','mcp:read','mcp:document:write'],
    grants: { [base.subject]: {
      clients: [clientId], devices: [deviceId], tools,
    } },
  });
  const signToken = (scope) => provider.signClaimsForTest({
    iss: issuer, aud: audience, sub: base.subject, client_id: clientId,
    scope, jti: randomBytes(20).toString('base64url'),
    iat: at(), nbf: at(), exp: at() + 300,
  });
  const fullToken = signToken('mcp:discover mcp:read mcp:document:write');
  const noDocToken = signToken('mcp:discover mcp:read');
  const sessions = new Map();
  const gateway = createMcpToolProfiles({
    handlers: {
      list_devices: () => [{ id: deviceId }],
      read_file: args => ({ path: args.path, content: 'local-mock' }),
      write_pdf: args => ({ path: args.path, bytes: 233, mocked: true }),
    },
    verifySession: receipt => receipt?.trusted === true ? {
      ...base, expiresAt: at() * 1_000 + 60_000,
      allowedTools: ['list_devices','read_file','write_pdf'],
      capabilities: ['workspace:read', 'document:write'],
    } : null,
    now: () => at() * 1_000,
  });
  let signatureVerifications = 0;
  const countedAuthorizer = {
    ...authorizer,
    validateBearer(...args) {
      signatureVerifications++;
      return authorizer.validateBearer(...args);
    },
  };
  const relay = createLocalMcpRelay({
    oauthResource: countedAuthorizer, agentToken: 'a'.repeat(50), deviceId,
    toolProfileBinding: {
      gateway,
      resolveVerifiedHandle(principal) {
        if (!principal.ok || principal.subject !== base.subject ||
            principal.clientId !== clientId) throw Error('UNVERIFIED_PRINCIPAL');
        if (!sessions.has(principal.tokenId))
          sessions.set(principal.tokenId, gateway.register({ trusted: true }));
        return sessions.get(principal.tokenId);
      },
    },
  });
  const { port } = await relay.listen();
  t.after(() => relay.close());
  async function request(method, params = {}, token = fullToken) {
    const body = { jsonrpc:'2.0', id:44, method, params: {
      ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientInfo': { name:'fixture',version:'1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    } };
    const headers = {
      'Content-Type':'application/json',
      'Accept':'application/json, text/event-stream',
      Authorization:'Bearer '+token,
      'MCP-Protocol-Version':MODERN, 'Mcp-Method':method,
      ...(method==='tools/call'?{'Mcp-Name':params.name}:{}),
    };
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method:'POST',headers,body:JSON.stringify(body),
    });
    return {status:res.status, body: await res.json()};
  }
  const beforeList = signatureVerifications;
  const listed = await request('tools/list');
  assert.equal(signatureVerifications, beforeList + 1,
    'One signature verification per request regardless of advertised tool count');
  assert.equal(listed.status,200);
  assert.deepEqual(listed.body.result.tools.map(x=>x.name),['list_devices','read_file']);
  const beforeCall = signatureVerifications;
  const approved = await request('tools/call', {name:'write_pdf',arguments:{
    path:'fixture.pdf',content:'# Fixture',
  }});
  assert.equal(signatureVerifications, beforeCall + 1,
    'One signature verification even when invoking exact-name hidden tool');
  assert.equal(approved.status,200);
  assert.deepEqual(JSON.parse(approved.body.result.content[0].text),
    {path:'fixture.pdf',bytes:233,mocked:true});
  const denied = await request('tools/call',{name:'write_pdf',arguments:{
    path:'fixture.pdf',content:'# Fixture',
  }},noDocToken);
  assert.equal(denied.status,403);
  assert.equal(denied.body.error,'INSUFFICIENT_SCOPE');
  const hiddenUnauthorized = await request('tools/call',{name:'delete_file',arguments:{
    path:'anything.txt',
  }});
  assert.equal(hiddenUnauthorized.status,403);
  const wrongHost = await request('tools/call',{name:'read_file',arguments:{
    deviceId:'unapproved-device',path:'fixture.txt',
  }});
  assert.equal(wrongHost.status,200);
  assert.equal(wrongHost.body.result.isError,true);
  assert.match(wrongHost.body.result.content[0].text,/TOOL_NOT_AUTHORIZED/);
  // Only a proof object created by this verifier's successful JWT signature
  // check may authorize a tool. Changing public Set properties cannot
  // escalate its private, captured subject/device/tool/scope grants.
  assert.equal(authorizer.authorizeVerifiedPrincipal({
    ok:true, scopes:new Set(['mcp:admin']), tools:new Set(['shutdown']),
    devices:new Set([deviceId]),
  }, {tool:'shutdown',deviceId}).code, 'UNVERIFIED_PRINCIPAL');
  const validProof = authorizer.validateBearer('Bearer '+fullToken);
  assert.equal(validProof.ok,true);
  validProof.tools.add('delete_file');
  validProof.scopes.add('mcp:admin');
  validProof.devices.add('unapproved-device');
  assert.equal(authorizer.authorizeVerifiedPrincipal(validProof,{
    tool:'delete_file',deviceId,
  }).code,'INSUFFICIENT_SCOPE');
  assert.equal(authorizer.authorizeVerifiedPrincipal(validProof,{
    tool:'read_file',deviceId:'unapproved-device',
  }).code,'DEVICE_NOT_AUTHORIZED');
  const restrictedToken = provider.signClaimsForTest({
    iss: issuer, aud: audience, sub: base.subject, client_id: clientId,
    scope: 'mcp:discover mcp:read', devices:['another-device'],
    jti:randomBytes(20).toString('base64url'),
    iat:at(), nbf:at(), exp:at()+300,
  });
  const restrictedProof = authorizer.validateBearer('Bearer '+restrictedToken);
  assert.equal(restrictedProof.ok,true);
  assert.equal(authorizer.authorizeVerifiedPrincipal(restrictedProof,{
    tool:'read_file',deviceId,
  }).code,'DEVICE_NOT_AUTHORIZED');
  provider.revoke(fullToken);
  assert.equal(authorizer.authorizeVerifiedPrincipal(validProof,{
    tool:'read_file',deviceId,
  }).code,'INVALID_TOKEN');
});
