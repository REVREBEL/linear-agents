// ABR-97: device selection is not an authorization grant.
// Interactive user selection and Linear's trusted Agent Location are separate.
// This module never opens SSH/WS connections or fabricates a Mac identity.
import { chooseExecutionHost } from '../../../routing/hosts/host-routing.mjs';

const HOST_MAP = Object.freeze({
  macos: 'macos-runtime', 'bridge-server': 'rebel-server',
});
const ID = /^[a-zA-Z0-9_.:@-]{1,192}$/;
const MAX_AGE_MS = 60 * 60_000;

function strings(values, limit = 128) {
  if (!Array.isArray(values) || values.length > limit ||
      values.some(value => typeof value !== 'string' || !ID.test(value)))
    throw Error('INVALID_VERIFIED_GRANT');
  return new Set(values);
}
function validateVerified(raw, mode, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.mode !== mode || !ID.test(raw.subject ?? '') ||
      !ID.test(raw.sessionId ?? '') || !ID.test(raw.tenantId ?? '') ||
      !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= now() ||
      raw.expiresAt > now() + MAX_AGE_MS)
    throw Error('UNVERIFIED_SESSION');
  const allowedDevices = strings(raw.allowedDevices, 2);
  const tools = strings(raw.tools);
  const workspaces = strings(raw.workspaces);
  if (!allowedDevices.size || !tools.size || !workspaces.size)
    throw Error('EMPTY_VERIFIED_GRANTS');
  if (raw.defaultDevice !== null && raw.defaultDevice !== undefined &&
      !allowedDevices.has(raw.defaultDevice)) throw Error('INVALID_VERIFIED_DEFAULT');
  return {
    mode, subject: raw.subject, tenantId: raw.tenantId,
    sessionId: raw.sessionId, expiresAt: raw.expiresAt,
    devices: allowedDevices, tools, workspaces,
    defaultDevice: raw.defaultDevice ?? null,
    selectedDevice: raw.selectedDevice ?? null,
    jobId: raw.jobId ?? null, agentId: raw.agentId ?? null,
  };
}
export function createDeviceRouting({
  enrollment, verifyInteractive, verifyLinearAdmission,
  verifyLinearJobAlive, now = () => Date.now(),
}) {
  if (!enrollment || typeof enrollment.requireOnline !== 'function' ||
      typeof verifyInteractive !== 'function' ||
      typeof verifyLinearAdmission !== 'function' ||
      typeof verifyLinearJobAlive !== 'function')
    throw TypeError('TRUSTED_DEVICE_ROUTING_ADAPTERS_REQUIRED');
  const sessions = new WeakMap();
  function bindGenerations(grant) {
    const generations = new Map();
    for (const id of grant.devices) {
      const current = enrollment.inspect(id);
      if (!current || current.tenantId !== grant.tenantId)
        throw Error('DEVICE_NOT_ENROLLED_OR_TENANT_MISMATCH');
      generations.set(id, current.generation);
    }
    grant.generations = generations;
    return grant;
  }
  function registerInteractive(credentials) {
    const verified = bindGenerations(validateVerified(verifyInteractive(credentials), 'interactive', now));
    if (verified.selectedDevice && !verified.devices.has(verified.selectedDevice))
      throw Error('UNAUTHORIZED_SESSION_DEFAULT');
    const handle = Object.freeze(Object.create(null));
    sessions.set(handle, verified);
    return handle;
  }
  function registerLinear(jobReceipt) {
    // The receipt must be validated against the authoritative admission/job
    // ledger. Never derive Agent Location from client JSON or raw Linear labels.
    const admission = verifyLinearAdmission(jobReceipt);
    const verified = bindGenerations(validateVerified(admission, 'linear', now));
    if (!ID.test(admission.jobId ?? '') || !ID.test(admission.agentId ?? ''))
      throw Error('UNVERIFIED_LINEAR_ADMISSION');
    const chosen = chooseExecutionHost({ agentLocation: admission.agentLocation });
    if (!chosen.ok) throw Error('INVALID_TRUSTED_AGENT_LOCATION');
    const requiredDevice = HOST_MAP[chosen.host];
    if (!requiredDevice || !verified.devices.has(requiredDevice))
      throw Error('LINEAR_DEVICE_SCOPE_MISMATCH');
    verified.jobId = admission.jobId;
    verified.agentId = admission.agentId;
    verified.requiredDevice = requiredDevice;
    verified.selectedDevice = requiredDevice;
    const handle = Object.freeze(Object.create(null));
    sessions.set(handle, verified);
    return handle;
  }
  function requireSession(handle, mode) {
    const grant = sessions.get(handle);
    if (!grant || grant.mode !== mode || grant.expiresAt <= now())
      throw Error('SESSION_NOT_AUTHORIZED');
    if (mode === 'linear' && verifyLinearJobAlive({
      jobId: grant.jobId, agentId: grant.agentId,
      sessionId: grant.sessionId, tenantId: grant.tenantId,
    }) !== true) throw Error('STALE_LINEAR_JOB');
    return grant;
  }
  function chooseInteractive(handle, deviceId) {
    const grant = requireSession(handle, 'interactive');
    if (!grant.devices.has(deviceId)) throw Error('DEVICE_NOT_AUTHORIZED');
    const device = enrollment.requireOnline(deviceId, grant.generations.get(deviceId));
    if (device.tenantId !== grant.tenantId ||
        !device.users.includes(grant.subject)) throw Error('DEVICE_NOT_AUTHORIZED');
    grant.selectedDevice = deviceId;
    return { deviceId, status: 'selected', generation: device.generation };
  }
  function dispatch(grant, request, deviceId) {
    if (!request || typeof request !== 'object' ||
        !ID.test(request.tool ?? '') ||
        !ID.test(request.workspaceId ?? '')) throw Error('INVALID_DEVICE_REQUEST');
    if (!grant.devices.has(deviceId)) {
      enrollment.audit(deviceId, 'route:' + grant.mode, 'denied', 'DEVICE_NOT_AUTHORIZED');
      throw Error('DEVICE_NOT_AUTHORIZED');
    }
    if (request.deviceId !== undefined && request.deviceId !== deviceId) {
      enrollment.audit(deviceId, 'route:' + grant.mode, 'denied', 'CONFLICTING_DEVICE_ID');
      throw Error('CONFLICTING_DEVICE_ID');
    }
    let device;
    try { device = enrollment.requireOnline(deviceId, grant.generations.get(deviceId)); }
    catch (error) {
      enrollment.audit(deviceId, 'route:' + grant.mode, 'denied',
        String(error.message).slice(0, 90));
      throw error;
    }
    if (device.tenantId !== grant.tenantId ||
        !grant.tools.has(request.tool) || !device.tools.includes(request.tool) ||
        !grant.workspaces.has(request.workspaceId) ||
        !Object.hasOwn(device.workspaces, request.workspaceId))
      throw Error('DEVICE_NOT_AUTHORIZED');
    if (grant.mode === 'interactive' && !device.users.includes(grant.subject))
      throw Error('DEVICE_NOT_AUTHORIZED');
    if (grant.mode === 'linear' && !device.agents.includes(grant.agentId))
      throw Error('DEVICE_NOT_AUTHORIZED');
    const result = {
      deviceId, platform: device.platform, transport: device.transport,
      workspaceId: request.workspaceId, tool: request.tool,
      generation: device.generation,
      tenantId: grant.tenantId,
      authority: grant.mode,
      // No OS filesystem path, signing key or client-supplied host selector
      // is ever supplied as executable authority from this routing decision.
    };
    enrollment.audit(deviceId, 'route:' + grant.mode, 'allowed', 'HOST_GRANT_VERIFIED');
    return Object.freeze(result);
  }
  function routeInteractive(handle, request) {
    const grant = requireSession(handle, 'interactive');
    // A tool argument is never itself a host-selection authorization.
    // Selection must originate from the verified interactive session
    // (default) or an explicit chooseInteractive user action.
    const deviceId = grant.selectedDevice ?? grant.defaultDevice;
    if (!deviceId) {
      enrollment.audit(null, 'route:interactive', 'denied', 'DEVICE_SELECTION_REQUIRED');
      throw Error('DEVICE_SELECTION_REQUIRED');
    }
    return dispatch(grant, request, deviceId);
  }
  function routeLinear(handle, request) {
    const grant = requireSession(handle, 'linear');
    // Trusted location never falls back to a different online host.
    return dispatch(grant, request, grant.requiredDevice);
  }
  function revokeSession(handle) {
    return sessions.delete(handle);
  }
  return Object.freeze({
    registerInteractive, registerLinear, chooseInteractive,
    routeInteractive, routeLinear, revokeSession,
  });
}
