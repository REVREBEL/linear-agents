// ABR-97 offline dual-host enrollment, revocation, routing and macOS SSH tests.
// Pure fixture; never generates live Mac keys or modifies known_hosts/launchd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeviceEnrollment } from '../bridge/agent/mcp-host-agent/device-enrollment.mjs';
import { createDeviceRouting } from '../bridge/agent/mcp-host-agent/device-routing.mjs';
import { validateMacDiscovery, probeMacOverTrustedSsh } from '../bridge/agent/mcp-host-agent/macos-host-probe.mjs';

const nowObj = { at: 1_900_000_000_000 };
const now = () => nowObj.at;
const operator = { operatorId: 'approved-reviewer', approved: true };
const key = () => generateKeyPairSync('ed25519');
const signature = (payload, privateKey) =>
  sign(null, Buffer.from(payload), privateKey).toString('base64url');

function makeConfig(deviceId, signingKey = key(), tenantId = 'tenant-one') {
  const mac = deviceId === 'macos-runtime';
  return { deviceId, platform: mac ? 'darwin' : 'linux',
    transport: mac ? 'ssh' : 'paired-ws',
    principal: mac ? 'mac-fixture-principal' : 'bridge',
    tenantId, transportFingerprint: (mac ? 'a' : 'b').repeat(64),
    publicKeyPem: signingKey.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    workspaces: { project: mac ? '/Users/mac-fixture/projects/project' : '/home/bridge/projects/project' },
    users: ['interactive-one'], agents: ['coding-agent'],
    tools: ['read_file', 'run_command', 'list_devices'],
    privateKey: signingKey.privateKey,
  };
}
function allowedConfig(config) {
  const { privateKey, ...publicConfig } = config;
  return publicConfig;
}
function attestation(config) {
  return { deviceId: config.deviceId, platform: config.platform, transport: config.transport,
    principal: config.principal, transportFingerprint: config.transportFingerprint,
    // Trusted transport evidence is issued by the verifier, not supplied as
    // a JSON "verified" field in a tool request.
    recognizedByVerifier: true };
}
function createStore(directory, seenEvents = []) {
  const db = createDeviceEnrollment({
    journalDir: directory,
    now,
    approveOperator: context => context?.approved === true && context.operatorId === operator.operatorId
      ? { operatorId: operator.operatorId } : null,
    verifyTransport: (observed, expected) =>
      observed?.recognizedByVerifier === true &&
      Object.entries(expected).every(([name, value]) => observed[name] === value)
        ? observed : null,
  });
  return db;
}
function enroll(store, config, options) {
  const challenge = store.requestPairing(operator, allowedConfig(config), options);
  return { challenge, record: store.activatePairing({
    deviceId: config.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, config.privateKey),
    attestation: attestation(config),
    ...(options?.rotate ? { previousSignature: options.previousSignature } : {}),
  }) };
}
function verifiedInteractive(overrides = {}) {
  return { mode: 'interactive', subject: 'interactive-one',
    tenantId: 'tenant-one', sessionId: 'chat-session-1',
    expiresAt: now() + 30_000,
    allowedDevices: ['macos-runtime', 'rebel-server'],
    tools: ['read_file', 'list_devices'], workspaces: ['project'],
    defaultDevice: null, selectedDevice: null, ...overrides };
}
function verifiedLinear(overrides = {}) {
  return { mode: 'linear', subject: 'bridge-reviewer',
    agentId: 'coding-agent', jobId: 'ABR-97-fixture-job',
    tenantId: 'tenant-one', sessionId: 'linear-session-1',
    expiresAt: now() + 30_000,
    allowedDevices: ['macos-runtime', 'rebel-server'],
    tools: ['read_file', 'run_command'], workspaces: ['project'],
    agentLocation: 'agent-location:mac', ...overrides };
}
function setupRouting(store, linearAdmissions) {
  const alive = new Set(['ABR-97-fixture-job']);
  const routing = createDeviceRouting({
    enrollment: store, now,
    verifyInteractive: credential => credential?.trusted === true
      ? credential.grant : null,
    verifyLinearAdmission: receipt => linearAdmissions.get(receipt) ?? null,
    verifyLinearJobAlive: job =>
      alive.has(job.jobId) && job.tenantId === 'tenant-one' &&
      job.agentId === 'coding-agent',
  });
  return { routing, alive };
}
async function fixture(t) {
  const previous = nowObj.at;
  const directory = await mkdtemp(path.join(tmpdir(), 'abr97-enrollment-'));
  const store = createStore(directory);
  const mac = makeConfig('macos-runtime');
  const ubuntu = makeConfig('rebel-server');
  enroll(store, mac);
  enroll(store, ubuntu);
  t.after(async () => {
    store.close();
    nowObj.at = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return { store, mac, ubuntu };
}

test('ABR-97 pairing enforces operator approval, signed challenge and unique device/OS transport', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'abr97-pair-'));
  const events = [];
  const store = createStore(dir, events);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const mac = makeConfig('macos-runtime');
  assert.throws(() => store.requestPairing({}, allowedConfig(mac)), /OPERATOR_APPROVAL_REQUIRED/);
  assert.throws(() => store.requestPairing(operator,
    { ...allowedConfig(mac), platform: 'linux' }), /INVALID_DEVICE_CONFIG/);
  assert.throws(() => store.requestPairing(operator,
    { ...allowedConfig(mac), workspaces: { project: '/Users/mac-fixture/projects/../../private' } }),
  /INVALID_WORKSPACE/);
  const challenge = store.requestPairing(operator, allowedConfig(mac));
  assert.ok(challenge.expiresAt > now());
  const wrongKey = key();
  assert.throws(() => store.activatePairing({
    deviceId: mac.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, wrongKey.privateKey),
    attestation: attestation(mac),
  }), /INVALID_HOST_SIGNATURE/);
  assert.throws(() => store.activatePairing({
    deviceId: mac.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, mac.privateKey),
    attestation: { ...attestation(mac), principal: 'intruder' },
  }), /TRANSPORT_IDENTITY_MISMATCH/);
  const accepted = store.activatePairing({
    deviceId: mac.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, mac.privateKey),
    attestation: attestation(mac),
  });
  assert.equal(accepted.status, 'active');
  assert.equal(accepted.principal, mac.principal);
  assert.equal(accepted.platform, 'darwin');
  assert.equal(accepted.transport, 'ssh');
  assert.equal(accepted.generation, 1);
  assert.throws(() => store.activatePairing({
    deviceId: mac.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, mac.privateKey),
    attestation: attestation(mac),
  }), /STALE_OR_UNKNOWN_CHALLENGE/);
  assert.throws(() => store.requestPairing(operator, allowedConfig(mac)),
    /EXPLICIT_REENROLLMENT_REQUIRED/);
  assert.ok(store.auditLog().some(log => log.decision === 'denied'));
});

test('ABR-97 expired pairing, offline heartbeat, pause/revoke and audited re-enrollment', async t => {
  const { store, mac, ubuntu } = await fixture(t);
  assert.deepEqual(store.list().map(x=>x.deviceId), ['macos-runtime','rebel-server']);
  assert.equal(store.requireOnline('macos-runtime').generation, 1);
  nowObj.at += 100_000;
  assert.throws(() => store.requireOnline('macos-runtime'), /DEVICE_OFFLINE/);
  const proof = store.heartbeatChallenge('macos-runtime');
  const refresh = store.completeHeartbeat({
    deviceId: mac.deviceId, nonce: proof.nonce,
    signature: signature(proof.payload, mac.privateKey),
    attestation: attestation(mac),
  });
  assert.equal(refresh.generation, 1);
  assert.throws(() => store.completeHeartbeat({
    deviceId: mac.deviceId, nonce: proof.nonce,
    signature: signature(proof.payload, mac.privateKey),
    attestation: attestation(mac),
  }), /STALE_HEARTBEAT/);
  const paused = store.pause(operator, 'macos-runtime');
  assert.equal(paused.status, 'paused');
  assert.throws(() => store.requireOnline('macos-runtime'), /DEVICE_NOT_ACTIVE/);
  assert.equal(store.inspect('rebel-server').platform, 'linux');
  assert.throws(() => store.requestPairing({}, allowedConfig(mac)),
    /OPERATOR_APPROVAL_REQUIRED/);
  const restored = enroll(store, mac).record;
  assert.equal(restored.generation, 3);
  assert.equal(restored.status, 'active');
  const revoked = store.revoke(operator, 'macos-runtime');
  assert.equal(revoked.status, 'revoked');
  assert.throws(() => store.requireOnline('macos-runtime'), /DEVICE_NOT_ACTIVE/);
  assert.throws(() => store.requestPairing(operator,
    { ...allowedConfig(mac), tenantId: 'wrong-tenant' }), /CROSS_TENANT_REENROLLMENT_DENIED/);
  assert.equal(enroll(store, mac).record.generation, 5);
  assert.ok(store.auditLog().some(e => e.action === 'revoke' && e.decision === 'allowed'));
});

test('ABR-97 rotation requires old and new private keys; old device generation rejected', async t => {
  const { store, mac } = await fixture(t);
  const next = makeConfig('macos-runtime', key());
  const challenge = store.requestPairing(operator, allowedConfig(next), { rotate: true });
  assert.throws(() => store.activatePairing({
    deviceId: next.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, next.privateKey),
    attestation: attestation(next),
  }), /INVALID_PREVIOUS_HOST_SIGNATURE/);
  const verified = store.activatePairing({
    deviceId: next.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, next.privateKey),
    previousSignature: signature(challenge.payload, mac.privateKey),
    attestation: attestation(next),
  });
  assert.equal(verified.generation, 2);
  assert.throws(() => store.requireOnline('macos-runtime', 1), /STALE_DEVICE_GENERATION/);
  assert.equal(store.requireOnline('macos-runtime', 2).generation, 2);
});

test('ABR-97 interactive defaults require verified session choice, no offline fallback', async t => {
  const { store, mac } = await fixture(t);
  const { routing } = setupRouting(store, new Map());
  const request = { tool: 'read_file', workspaceId: 'project' };
  const handle = routing.registerInteractive({ trusted: true, grant: verifiedInteractive() });
  assert.throws(() => routing.routeInteractive(handle, request), /DEVICE_SELECTION_REQUIRED/);
  assert.throws(() => routing.routeInteractive(handle, { ...request, deviceId: 'macos-runtime' }),
    /DEVICE_SELECTION_REQUIRED/);
  assert.deepEqual(routing.chooseInteractive(handle, 'macos-runtime').deviceId, 'macos-runtime');
  const selected = routing.routeInteractive(handle, request);
  assert.deepEqual([selected.deviceId, selected.platform, selected.transport],
    ['macos-runtime', 'darwin', 'ssh']);
  assert.throws(() => routing.routeInteractive(handle,
    { ...request, deviceId: 'rebel-server' }), /CONFLICTING_DEVICE_ID/);
  store.pause(operator, 'macos-runtime');
  assert.throws(() => routing.routeInteractive(handle, request), /DEVICE_NOT_ACTIVE/);
  // A deliberately selected, separately authorized host is allowed; only
  // implicit offline fallback is forbidden.
  assert.equal(routing.chooseInteractive(handle, 'rebel-server').deviceId, 'rebel-server');
  assert.equal(routing.routeInteractive(handle, request).deviceId, 'rebel-server');
  assert.equal(store.requireOnline('rebel-server').status, 'active');
  const fresh = routing.registerInteractive({
    trusted: true,
    grant: verifiedInteractive({ defaultDevice: 'rebel-server', allowedDevices: ['rebel-server'] }),
  });
  assert.equal(routing.routeInteractive(fresh, request).deviceId, 'rebel-server');
  assert.equal(routing.revokeSession(fresh), true);
  assert.throws(() => routing.routeInteractive(fresh, request), /SESSION_NOT_AUTHORIZED/);
});

test('ABR-97 verified Linear admission only selects exact trusted Agent Location', async t => {
  const { store } = await fixture(t);
  const receipt = Object.freeze({});
  const forgedReceipt = Object.freeze({ agentLocation: 'bridge-server' });
  const admissions = new Map([[receipt, verifiedLinear()]]);
  const { routing, alive } = setupRouting(store, admissions);
  assert.throws(() => routing.registerLinear(forgedReceipt), /UNVERIFIED_SESSION/);
  const handle = routing.registerLinear(receipt);
  const request = { tool: 'run_command', workspaceId: 'project' };
  assert.equal(routing.routeLinear(handle, request).deviceId, 'macos-runtime');
  assert.throws(() => routing.routeLinear(handle,
    { ...request, deviceId: 'rebel-server' }), /CONFLICTING_DEVICE_ID/);
  alive.delete('ABR-97-fixture-job');
  assert.throws(() => routing.routeLinear(handle, request), /STALE_LINEAR_JOB/);
  alive.add('ABR-97-fixture-job');
  store.revoke(operator, 'macos-runtime');
  assert.throws(() => routing.routeLinear(handle, request), /DEVICE_NOT_ACTIVE/);
  const fallback = Object.freeze({});
  admissions.set(fallback, verifiedLinear({ agentLocation: null,
    allowedDevices: ['rebel-server'] }));
  const trustedDefault = routing.registerLinear(fallback);
  assert.equal(routing.routeLinear(trustedDefault, request).deviceId, 'rebel-server');
  const rejected = Object.freeze({});
  admissions.set(rejected, verifiedLinear({ agentLocation: 'agent-location:mac',
    allowedDevices: ['rebel-server'] }));
  assert.throws(() => routing.registerLinear(rejected), /LINEAR_DEVICE_SCOPE_MISMATCH/);
  assert.ok(store.auditLog().some(e => e.action === 'route:linear' &&
    e.decision === 'denied'));
});

test('ABR-97 stale session cannot revive after device re-pair or key rotation', async t => {
  const { store, mac } = await fixture(t);
  const { routing } = setupRouting(store, new Map());
  const old = routing.registerInteractive({
    trusted: true, grant: verifiedInteractive({ defaultDevice: 'macos-runtime' }),
  });
  assert.equal(routing.routeInteractive(old, {
    tool: 'read_file', workspaceId: 'project',
  }).generation, 1);
  store.revoke(operator, 'macos-runtime');
  enroll(store, mac);
  assert.throws(() => routing.routeInteractive(old,
    { tool: 'read_file', workspaceId: 'project' }), /STALE_DEVICE_GENERATION/);
  const renewed = routing.registerInteractive({
    trusted: true, grant: verifiedInteractive({ defaultDevice: 'macos-runtime' }),
  });
  assert.equal(routing.routeInteractive(renewed, {
    tool: 'read_file', workspaceId: 'project',
  }).generation, 3);
});

test('ABR-97 SSH host discovery validates real launchd identity and rejects spoofing', async () => {
  const mac = {
    platform: 'Darwin', principal: 'mac-fixture-principal', uid: 501,
    projectsRoot: '/Users/mac-fixture/projects',
    repoRoot: '/Users/mac-fixture/projects/linear-agents',
    projectRootSource: 'launchd-repository-parent',
    launchAgent: 'io.revrebel.agent-bridge',
    node: '/Users/mac-fixture/.nvm/current/bin/node',
  };
  assert.equal(validateMacDiscovery(mac).uid, 501);
  assert.throws(() => validateMacDiscovery({ ...mac, principal: 'spoofed' },
    { expectedPrincipal: mac.principal }), /MAC_IDENTITY_MISMATCH/);
  assert.throws(() => validateMacDiscovery({ ...mac, repoRoot: '/etc' }),
    /MAC_CONFIG_UNVERIFIED/);
  assert.throws(() => validateMacDiscovery({ ...mac, projectsRoot: '/' }),
    /MAC_CONFIG_UNVERIFIED/);
  await assert.rejects(probeMacOverTrustedSsh({ sshAlias: '-oProxyCommand=evil' }),
    /UNAPPROVED_SSH_TARGET/);
});


test('ABR-97 Mac SSH probe cannot weaken pinned host-key checking or inject commands', async () => {
  const value = {
    platform: 'Darwin', principal: 'mac-fixture-principal', uid: 501,
    projectsRoot: '/Users/mac-fixture/projects',
    repoRoot: '/Users/mac-fixture/projects/linear-agents',
    projectRootSource: 'launchd-repository-parent',
    launchAgent: 'io.revrebel.agent-bridge',
    node: '/Users/mac-fixture/.nvm/current/bin/node',
  };
  const launch = (exe, args, options) => {
    assert.equal(exe, '/usr/bin/ssh');
    const flags = args.join(' ');
    assert.match(flags, /StrictHostKeyChecking=yes/);
    assert.match(flags, /BatchMode=yes/);
    assert.match(flags, /ForwardAgent=no/);
    assert.match(flags, /ClearAllForwardings=yes/);
    assert.match(flags, /macos/);
    assert.equal(options.stdio[0], 'ignore');
    assert.ok(!flags.includes('StrictHostKeyChecking=no'));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify(value));
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };
  const verified = await probeMacOverTrustedSsh({
    sshAlias: 'macos', expectedPrincipal: value.principal, launch,
  });
  assert.equal(verified.repoRoot, value.repoRoot);
  await assert.rejects(probeMacOverTrustedSsh({
    sshAlias: 'malicious;touch_bad', launch,
  }), /UNAPPROVED_SSH_TARGET/);
  await assert.rejects(probeMacOverTrustedSsh({
    sshAlias: 'macos', expectedPrincipal: 'wrong-user', launch,
  }), /MAC_IDENTITY_MISMATCH/);
});

test('ABR-97 offline Mac host-key failure cannot masquerade as successful discovery', async () => {
  const launch = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.write('Host key verification failed.');
      child.stderr.end();
      child.emit('close', 255);
    });
    return child;
  };
  await assert.rejects(probeMacOverTrustedSsh({ sshAlias: 'macos', launch }),
    /MAC_SSH_HOST_KEY_NOT_TRUSTED/);
});

test('revocation during pairing verification cannot reactivate a stale challenge', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'abr97-stale-'));
  let store, revokeDuringVerification = false;
  store = createDeviceEnrollment({
    journalDir: dir, now,
    approveOperator: context => context?.approved ? { operatorId: context.operatorId } : null,
    verifyTransport: observed => {
      if (revokeDuringVerification) {
        revokeDuringVerification = false;
        store.revoke(operator, observed.deviceId);
      }
      return observed;
    },
  });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const mac = makeConfig('macos-runtime');
  enroll(store, mac);
  const next = makeConfig('macos-runtime', key());
  const challenge = store.requestPairing(operator, allowedConfig(next), { rotate: true });
  revokeDuringVerification = true;
  assert.throws(() => store.activatePairing({
    deviceId: next.deviceId, nonce: challenge.nonce,
    signature: signature(challenge.payload, next.privateKey),
    previousSignature: signature(challenge.payload, mac.privateKey),
    attestation: attestation(next),
  }), /STALE_OR_UNKNOWN_CHALLENGE/);
  assert.equal(store.inspect(next.deviceId).status, 'revoked');
  assert.throws(() => store.requireOnline(next.deviceId), /DEVICE_NOT_ACTIVE/);
});
