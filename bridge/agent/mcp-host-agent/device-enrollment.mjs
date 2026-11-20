// ABR-97: independent, operator-approved device enrollment source module.
// No production listener, launchd/systemd install, token issuance or CLI dispatch.
// Verified transport identity MUST come from an injected, trusted SSH/WS verifier,
// never host-reported JSON or client-supplied deviceId.
import { DatabaseSync } from 'node:sqlite';
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DEVICE_PLATFORMS = Object.freeze({
  'rebel-server': 'linux', 'macos-runtime': 'darwin',
});
const DEVICE_TRANSPORT = Object.freeze({
  'rebel-server': 'paired-ws', 'macos-runtime': 'ssh',
});
const ID = /^[a-zA-Z0-9_.:@-]{1,128}$/;
const ROOT = /^[a-zA-Z0-9_-]{1,64}$/;
const PAIR_TTL_MS = 120_000;
const ONLINE_TTL_MS = 90_000;
const digest = text => createHash('sha256').update(text).digest('hex');
function approvedList(items) {
  if (!Array.isArray(items) || items.length > 64 ||
    items.some(x => typeof x !== 'string' || !ID.test(x))) throw TypeError('INVALID_APPROVED_LIST');
  return [...new Set(items)];
}
function approvedConfig(input) {
  if (!input || typeof input !== 'object' ||
      !Object.hasOwn(DEVICE_PLATFORMS, input.deviceId) ||
      input.platform !== DEVICE_PLATFORMS[input.deviceId] ||
      input.transport !== DEVICE_TRANSPORT[input.deviceId] ||
      !ID.test(input.principal ?? '') ||
      !ID.test(input.tenantId ?? '') ||
      !/^[a-f0-9]{64}$/.test(input.transportFingerprint ?? '') ||
      !input.workspaces || typeof input.workspaces !== 'object' ||
      Array.isArray(input.workspaces)) throw TypeError('INVALID_DEVICE_CONFIG');
  const workspaces = {};
  for (const [id, dir] of Object.entries(input.workspaces)) {
    if (!ROOT.test(id) || typeof dir !== 'string' || !path.posix.isAbsolute(dir) ||
        dir === '/' || dir.includes('\0') || dir.includes('\n') ||
        path.posix.normalize(dir) !== dir || dir.endsWith('/')) {
      throw TypeError('INVALID_WORKSPACE');
    }
    workspaces[id] = dir;
  }
  if (!Object.keys(workspaces).length) throw TypeError('MISSING_WORKSPACE');
  let key;
  try { key = createPublicKey(input.publicKeyPem); }
  catch { throw TypeError('INVALID_DEVICE_PUBLIC_KEY'); }
  if (key.asymmetricKeyType !== 'ed25519') throw TypeError('ED25519_REQUIRED');
  const publicKeyPem = key.export({ format: 'pem', type: 'spki' }).toString();
  const users = approvedList(input.users);
  const agents = approvedList(input.agents);
  const tools = approvedList(input.tools);
  if (!users.length && !agents.length) throw TypeError('EMPTY_PRINCIPAL_GRANTS');
  if (!tools.length) throw TypeError('EMPTY_TOOL_GRANTS');
  return {
    deviceId: input.deviceId, platform: input.platform, transport: input.transport,
    principal: input.principal, tenantId: input.tenantId,
    transportFingerprint: input.transportFingerprint,
    publicKeyPem, workspaces, users, agents, tools,
  };
}
function publicRecord(row) {
  if (!row) return null;
  const settings = JSON.parse(row.approved_json);
  return {
    deviceId: row.id, platform: settings.platform, transport: settings.transport,
    principal: settings.principal, tenantId: settings.tenantId,
    workspaces: { ...settings.workspaces }, users: [...settings.users],
    agents: [...settings.agents], tools: [...settings.tools],
    transportFingerprint: settings.transportFingerprint,
    keyFingerprint: digest(settings.publicKeyPem),
    status: row.status, generation: row.generation,
    lastSeenAt: row.last_seen_at, pairedAt: row.paired_at,
  };
}
function signatureOk(publicKeyPem, bytes, signature) {
  try {
    if (typeof signature !== 'string' || signature.length > 512) return false;
    return verifySignature(null, Buffer.from(bytes), publicKeyPem,
      Buffer.from(signature, 'base64url'));
  } catch { return false; }
}
export function makePairingProof({ type, config, nonce, generation }) {
  return JSON.stringify({
    purpose: 'revrebel.mcp.device.pairing.v1', type, nonce,
    deviceId: config.deviceId, platform: config.platform,
    principal: config.principal, transport: config.transport,
    keyFingerprint: digest(config.publicKeyPem),
    transportFingerprint: config.transportFingerprint,
    configFingerprint: digest(JSON.stringify(config)),
    tenantId: config.tenantId, generation,
  });
}

export function createDeviceEnrollment({
  journalDir, approveOperator, verifyTransport,
  now = () => Date.now(), onlineTtlMs = ONLINE_TTL_MS,
}) {
  if (typeof journalDir !== 'string' || !path.isAbsolute(journalDir) ||
      typeof approveOperator !== 'function' ||
      typeof verifyTransport !== 'function' ||
      !Number.isInteger(onlineTtlMs) || onlineTtlMs < 1_000 ||
      onlineTtlMs > 600_000) throw TypeError('EXPLICIT_ENROLLMENT_TRUST_REQUIRED');
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(journalDir);
  if (!stats.isDirectory() || stats.isSymbolicLink() ||
      stats.uid !== process.getuid?.()) throw Error('UNSAFE_ENROLLMENT_STORE');
  chmodSync(journalDir, 0o700);
  const db = new DatabaseSync(path.join(journalDir, 'devices.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, approved_json TEXT NOT NULL,
      status TEXT NOT NULL, generation INTEGER NOT NULL,
      last_seen_at INTEGER, paired_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pairing (
      id TEXT PRIMARY KEY, type TEXT NOT NULL,
      config_json TEXT NOT NULL, nonce_hash TEXT NOT NULL,
      generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL, device_id TEXT,
      action TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL
    );`);
  chmodSync(path.join(journalDir, 'devices.sqlite'), 0o600);
  const get = db.prepare('SELECT * FROM devices WHERE id=?');
  const pending = db.prepare('SELECT * FROM pairing WHERE id=?');
  const writePending = db.prepare(`INSERT INTO pairing
    (id,type,config_json,nonce_hash,generation,expires_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET type=excluded.type,config_json=excluded.config_json,
    nonce_hash=excluded.nonce_hash,generation=excluded.generation,expires_at=excluded.expires_at`);
  const auditWrite = db.prepare(`INSERT INTO audit
    (timestamp,device_id,action,decision,reason) VALUES(?,?,?,?,?)`);
  let closed = false;
  const heartbeats = new Map();
  function mustOpen() { if (closed) throw Error('ENROLLMENT_CLOSED'); }
  function audit(deviceId, action, decision, reason) {
    auditWrite.run(now(), typeof deviceId === 'string' ? deviceId : null,
      action, decision, reason);
  }
  function mustOperator(context, action, deviceId) {
    mustOpen();
    const principal = approveOperator(context, { action, deviceId });
    if (!principal || typeof principal !== 'object' || !ID.test(principal.operatorId ?? '')) {
      audit(deviceId, action, 'denied', 'UNAPPROVED_OPERATOR');
      throw Error('OPERATOR_APPROVAL_REQUIRED');
    }
    return principal.operatorId;
  }
  function requestPairing(operator, input, { rotate = false } = {}) {
    const config = approvedConfig(input);
    mustOperator(operator, rotate ? 'rotate' : 'enroll', config.deviceId);
    const existing = get.get(config.deviceId);
    if (rotate && (!existing || existing.status !== 'active')) throw Error('ACTIVE_DEVICE_REQUIRED');
    if (!rotate && existing && !['revoked', 'paused'].includes(existing.status)) throw Error('EXPLICIT_REENROLLMENT_REQUIRED');
    if (existing && JSON.parse(existing.approved_json).tenantId !== config.tenantId)
      throw Error('CROSS_TENANT_REENROLLMENT_DENIED');
    if (rotate && JSON.parse(existing.approved_json).principal !== config.principal)
      throw Error('PRINCIPAL_CHANGE_REQUIRES_REENROLLMENT');
    const type = rotate ? 'rotate' : 'enroll';
    const generation = existing ? existing.generation + 1 : 1;
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = now() + PAIR_TTL_MS;
    writePending.run(config.deviceId, type, JSON.stringify(config),
      digest(nonce), generation, expiresAt);
    audit(config.deviceId, type, 'approved', 'PAIRING_CHALLENGE_CREATED');
    return { deviceId: config.deviceId, type, nonce, expiresAt,
      generation, payload: makePairingProof({ type, config, nonce, generation }) };
  }
  function activatePairing({ deviceId, nonce, signature, previousSignature, attestation }) {
    mustOpen();
    const entry = pending.get(deviceId);
    if (!entry || entry.expires_at <= now() || digest(nonce ?? '') !== entry.nonce_hash) {
      audit(deviceId, 'activate', 'denied', 'STALE_OR_UNKNOWN_CHALLENGE');
      throw Error('STALE_OR_UNKNOWN_CHALLENGE');
    }
    const config = JSON.parse(entry.config_json);
    const data = makePairingProof({ type: entry.type, config, nonce, generation: entry.generation });
    if (!signatureOk(config.publicKeyPem, data, signature)) {
      audit(deviceId, 'activate', 'denied', 'INVALID_HOST_SIGNATURE');
      throw Error('INVALID_HOST_SIGNATURE');
    }
    const previous = get.get(deviceId);
    if (entry.type === 'rotate' && (!previous ||
        previous.generation + 1 !== entry.generation ||
        !signatureOk(JSON.parse(previous.approved_json).publicKeyPem, data, previousSignature))) {
      audit(deviceId, 'rotate', 'denied', 'INVALID_PREVIOUS_HOST_SIGNATURE');
      throw Error('INVALID_PREVIOUS_HOST_SIGNATURE');
    }
    // This callback is *trusted host-side transport verification*, not a
    // caller-supplied "verified: true" flag. It must inspect SSH host key /
    // paired-channel transport and observed OS identity independently.
    const observed = verifyTransport(attestation, {
      deviceId, platform: config.platform, transport: config.transport,
      transportFingerprint: config.transportFingerprint, principal: config.principal,
    });
    if (!observed || observed.deviceId !== deviceId ||
        observed.platform !== config.platform ||
        observed.principal !== config.principal ||
        observed.transportFingerprint !== config.transportFingerprint) {
      audit(deviceId, 'activate', 'denied', 'TRANSPORT_IDENTITY_MISMATCH');
      throw Error('TRANSPORT_IDENTITY_MISMATCH');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO devices
        (id,approved_json,status,generation,last_seen_at,paired_at)
        VALUES (?,?, 'active',?,?,?)
        ON CONFLICT(id) DO UPDATE SET
        approved_json=excluded.approved_json,status='active',
        generation=excluded.generation,last_seen_at=excluded.last_seen_at,
        paired_at=excluded.paired_at`).run(deviceId, entry.config_json,
        entry.generation, now(), now());
      db.prepare('DELETE FROM pairing WHERE id=?').run(deviceId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    heartbeats.delete(deviceId);
    audit(deviceId, entry.type, 'allowed', 'HOST_PAIRING_VERIFIED');
    return publicRecord(get.get(deviceId));
  }
  function inspect(deviceId) { mustOpen(); return publicRecord(get.get(deviceId)); }
  function list() {
    mustOpen();
    return db.prepare('SELECT * FROM devices ORDER BY id').all().map(publicRecord)
      .map(item => ({ ...item, online: item.status === 'active' &&
        item.lastSeenAt !== null && item.lastSeenAt + onlineTtlMs > now() }));
  }
  function requireOnline(deviceId, expectedGeneration = null) {
    const record = get.get(deviceId);
    if (!record || record.status !== 'active') throw Error('DEVICE_NOT_ACTIVE');
    if (expectedGeneration !== null && expectedGeneration !== record.generation)
      throw Error('STALE_DEVICE_GENERATION');
    if (record.last_seen_at === null || record.last_seen_at + onlineTtlMs <= now())
      throw Error('DEVICE_OFFLINE');
    return publicRecord(record);
  }
  function heartbeatChallenge(deviceId) {
    mustOpen();
    const current = get.get(deviceId);
    if (!current || current.status !== 'active') throw Error('DEVICE_NOT_ACTIVE');
    const row = publicRecord(current);
    const nonce = randomBytes(32).toString('base64url');
    heartbeats.set(deviceId, { nonceHash: digest(nonce),
      expiresAt: now() + 30_000, generation: row.generation });
    return { nonce, generation: row.generation,
      payload: JSON.stringify({
        purpose: 'revrebel.mcp.device.heartbeat.v1', deviceId, nonce,
        generation: row.generation,
      }) };
  }
  function completeHeartbeat({ deviceId, nonce, signature, attestation }) {
    mustOpen();
    const challenge = heartbeats.get(deviceId);
    heartbeats.delete(deviceId);
    if (!challenge || challenge.expiresAt <= now() ||
        challenge.nonceHash !== digest(nonce ?? '')) throw Error('STALE_HEARTBEAT');
    const current = get.get(deviceId);
    if (!current || current.status !== 'active' || current.generation !== challenge.generation)
      throw Error('STALE_DEVICE_GENERATION');
    const record = publicRecord(current);
    const approved = JSON.parse(get.get(deviceId).approved_json);
    const data = JSON.stringify({
      purpose: 'revrebel.mcp.device.heartbeat.v1', deviceId, nonce,
      generation: challenge.generation,
    });
    if (!signatureOk(approved.publicKeyPem, data, signature)) throw Error('INVALID_HOST_SIGNATURE');
    const observed = verifyTransport(attestation, {
      deviceId, platform: record.platform, principal: record.principal,
      transport: record.transport, transportFingerprint: record.transportFingerprint,
    });
    if (!observed || observed.deviceId !== deviceId ||
        observed.platform !== record.platform ||
        observed.principal !== record.principal ||
        observed.transportFingerprint !== record.transportFingerprint)
      throw Error('TRANSPORT_IDENTITY_MISMATCH');
    db.prepare('UPDATE devices SET last_seen_at=? WHERE id=? AND generation=? AND status=?')
      .run(now(), deviceId, challenge.generation, 'active');
    audit(deviceId, 'heartbeat', 'allowed', 'HOST_KEY_VERIFIED');
    return requireOnline(deviceId);
  }
  function changeStatus(operator, deviceId, action) {
    mustOperator(operator, action, deviceId);
    const row = get.get(deviceId);
    if (!row) throw Error('DEVICE_NOT_ENROLLED');
    const status = action === 'pause' ? 'paused' :
      action === 'revoke' ? 'revoked' : null;
    if (!status) throw Error('UNKNOWN_DEVICE_STATUS');
    if (row.status === 'revoked') throw Error('REENROLLMENT_REQUIRED');
    db.prepare('UPDATE devices SET status=?, generation=generation+1 WHERE id=?')
      .run(status, deviceId);
    db.prepare('DELETE FROM pairing WHERE id=?').run(deviceId);
    heartbeats.delete(deviceId);
    audit(deviceId, action, 'allowed', 'DEVICE_ACCESS_INVALIDATED');
    return publicRecord(get.get(deviceId));
  }
  function auditLog(limit = 50) {
    mustOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('INVALID_AUDIT_LIMIT');
    return db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit);
  }
  return Object.freeze({
    requestPairing, activatePairing, heartbeatChallenge, completeHeartbeat,
    requireOnline, inspect, list, auditLog,
    pause: (operator, deviceId) => changeStatus(operator, deviceId, 'pause'),
    revoke: (operator, deviceId) => changeStatus(operator, deviceId, 'revoke'),
    audit,
    close() { if (!closed) { closed = true; db.close(); } },
  });
}
