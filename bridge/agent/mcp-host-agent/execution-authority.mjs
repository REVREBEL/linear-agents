// ABR-96. An execution capability exists ONLY after a trusted MCP resource
// authorizer or Bridge admission layer verifies identity. Never issue one
// from tool arguments, environment variables, or host-agent output.
import { createHash } from 'node:crypto';

const NAME = /^[a-zA-Z0-9@._:-]{1,192}$/;
const DENIED = 'EXECUTION_NOT_AUTHORIZED';
function names(values) {
  if (!Array.isArray(values) || values.some(x => typeof x !== 'string' || !NAME.test(x)))
    throw TypeError('Explicit named grants required');
  return new Set(values);
}

export function createExecutionAuthority({
  deviceId, grants, ttlMs = 10 * 60_000, now = () => Date.now(),
}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000)
    throw TypeError('Capability TTL must be bounded');
  if (!NAME.test(deviceId ?? '') || !grants || typeof grants !== 'object')
    throw TypeError('Explicit device and server-owned grants required');
  const approved = new Map();
  const issued = new WeakMap();
  for (const [subject, grant] of Object.entries(grants)) {
    if (!NAME.test(subject) || !grant || typeof grant !== 'object')
      throw TypeError('Invalid authorized principal');
    approved.set(subject, {
      clients: names(grant.clients),
      sessions: names(grant.sessions),
      devices: names(grant.devices),
      workspaces: names(grant.workspaces),
      tools: names(grant.tools),
      write: grant.write === true,
    });
  }
  function issueFromVerifiedIdentity({ subject, clientId, sessionId, authenticatedDeviceId }) {
    const grant = approved.get(subject);
    if (!grant || !NAME.test(clientId ?? '') || !NAME.test(sessionId ?? '')
        || authenticatedDeviceId !== deviceId
        || !grant.clients.has(clientId) || !grant.sessions.has(sessionId)
        || !grant.devices.has(deviceId)) throw Error(DENIED);
    const scope = Object.freeze(Object.create(null));
    const key = createHash('sha256')
      .update([deviceId, subject, clientId, sessionId].join('\0')).digest('hex');
    issued.set(scope, {
      subject, clientId, sessionId, deviceId, key, grant,
      expiresAt: now() + ttlMs,
    });
    return scope;
  }
  function requireGrant(scope, tool, workspaceId, write = false) {
    const record = issued.get(scope);
    if (!record || record.expiresAt <= now() || !record.grant.tools.has(tool)
        || !record.grant.workspaces.has(workspaceId)
        || (write && !record.grant.write)) throw Error(DENIED);
    return { scopeKey: record.key, subject: record.subject, deviceId: record.deviceId };
  }
  function sameOwner(scope, scopeKey, tool, workspaceId) {
    const record = requireGrant(scope, tool, workspaceId);
    if (record.scopeKey !== scopeKey) throw Error(DENIED);
    return record;
  }
  function revoke(scope) {
    return issued.delete(scope);
  }
  return Object.freeze({ issueFromVerifiedIdentity, requireGrant, sameOwner, revoke });
}
