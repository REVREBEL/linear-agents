// ABR-95: testable, offline OAuth resource-server boundary.
//
// The authorization server is an existing trusted IdP, NOT this bridge.
// The caller must supply its validated issuer/JWKS trust bundle, resource
// audience and server-owned subject/device/tool grants. This module performs
// no network lookups, OAuth client registrations or token issuance.
import { createPublicKey, verify as verifySignature } from 'node:crypto';

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SUBJECT = /^[A-Za-z0-9@._:-]{1,256}$/;
const ALG = Object.freeze({
  RS256: { digest: 'RSA-SHA256', keyType: 'rsa', options: {} },
  ES256: { digest: 'sha256', keyType: 'ec', options: { dsaEncoding: 'ieee-p1363' } },
});

function jwtPart(value) {
  if (!JWT_SEGMENT.test(value) || value.length > 16_384) throw Error('INVALID_TOKEN');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw Error('INVALID_TOKEN');
  return decoded;
}
function decodeJson(value) {
  try {
    const decoded = JSON.parse(jwtPart(value).toString('utf8'));
    if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') throw Error();
    return decoded;
  } catch { throw Error('INVALID_TOKEN'); }
}
function exactIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 512
    && !value.includes('#') && !value.includes('?');
}
function normalizeGrants(grants) {
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw TypeError('Subject grants required');
  const scoped = new Map();
  for (const [subject, grant] of Object.entries(grants)) {
    if (!SUBJECT.test(subject) || !grant || typeof grant !== 'object'
        || !Array.isArray(grant.devices) || !Array.isArray(grant.tools)
        || !Array.isArray(grant.clients) || grant.clients.length === 0) {
      throw TypeError('Invalid authorized principal grant');
    }
    scoped.set(subject, {
      devices: new Set(grant.devices),
      tools: new Set(grant.tools),
      clients: new Set(grant.clients),
    });
  }
  return scoped;
}

export function createResourceAuthorizer({
  issuer, audience, jwks, grants, revoked = new Set(), now = () => Math.floor(Date.now() / 1000),
}) {
  if (!exactIdentifier(issuer) || !issuer.startsWith('https://')
      || !exactIdentifier(audience) || !audience.startsWith('https://')
      || !jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw TypeError('Explicit HTTPS issuer/resource audience and reviewed JWKS are required');
  }
  const keys = new Map();
  for (const jwk of jwks.keys) {
    if (typeof jwk.kid !== 'string' || !jwk.kid || !jwk.alg || !ALG[jwk.alg]
        || jwk.use !== 'sig' || keys.has(jwk.kid)) throw TypeError('Unsafe or duplicate signing key');
    let key;
    try { key = createPublicKey({ key: jwk, format: 'jwk' }); }
    catch { throw TypeError('Unusable public signing key'); }
    if (key.asymmetricKeyType !== ALG[jwk.alg].keyType) throw TypeError('Signing algorithm/key mismatch');
    keys.set(jwk.kid, { key, alg: jwk.alg });
  }
  const authorized = normalizeGrants(grants);
  const deny = (code) => ({ ok: false, code });

  function validateBearer(header, { tool = null, deviceId = null } = {}) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')
        || header.length > 18_000) return deny('MISSING_BEARER');
    const token = header.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3) return deny('INVALID_TOKEN');
    let headerJson, payload;
    try { headerJson = decodeJson(parts[0]); payload = decodeJson(parts[1]); }
    catch { return deny('INVALID_TOKEN'); }
    if (headerJson.typ !== 'at+jwt' || typeof headerJson.kid !== 'string'
        || !keys.has(headerJson.kid)) return deny('INVALID_TOKEN');
    const trusted = keys.get(headerJson.kid);
    if (headerJson.alg !== trusted.alg || headerJson.crit || headerJson.jku
        || headerJson.x5u || headerJson.jwk) return deny('INVALID_TOKEN');
    let verified = false;
    try {
      verified = verifySignature(ALG[trusted.alg].digest,
        Buffer.from(parts[0] + '.' + parts[1], 'ascii'),
        { key: trusted.key, ...ALG[trusted.alg].options },
        jwtPart(parts[2]));
    } catch { return deny('INVALID_TOKEN'); }
    if (!verified) return deny('INVALID_TOKEN');
    const current = now();
    if (payload.iss !== issuer || !Array.isArray(payload.aud)
        || payload.aud.length !== 1 || payload.aud[0] !== audience
        || !Number.isInteger(payload.exp) || payload.exp <= current
        || !Number.isInteger(payload.iat) || payload.iat > current + 30
        || payload.exp - payload.iat > 3600
        || (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > current))
        || !SUBJECT.test(payload.sub ?? '')
        || !SUBJECT.test(payload.client_id ?? '')
        || typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(payload.jti)
        || revoked.has(payload.jti)
        || typeof payload.scope !== 'string') return deny('INVALID_TOKEN');
    const scopes = new Set(payload.scope.split(' ').filter(Boolean));
    const principal = authorized.get(payload.sub);
    if (!principal || !principal.clients.has(payload.client_id)) {
      return deny('PRINCIPAL_NOT_AUTHORIZED');
    }
    const requiredScope = tool === 'read_file' ? 'mcp:read' : 'mcp:discover';
    if (!scopes.has(requiredScope) || !principal.tools.has(tool ?? 'tools/list')) {
      return deny('INSUFFICIENT_SCOPE');
    }
    if (deviceId !== null && (!principal.devices.has(deviceId)
        || (Array.isArray(payload.devices) && !payload.devices.includes(deviceId)))) {
      return deny('DEVICE_NOT_AUTHORIZED');
    }
    return { ok: true, subject: payload.sub, clientId: payload.client_id,
      scopes, devices: principal.devices, tools: principal.tools, tokenId: payload.jti };
  }

  function protectedMetadata() {
    return {
      resource: audience,
      authorization_servers: [issuer],
      scopes_supported: ['mcp:discover', 'mcp:read'],
      bearer_methods_supported: ['header'],
    };
  }

  return Object.freeze({ validateBearer, protectedMetadata, issuer, audience });
}
