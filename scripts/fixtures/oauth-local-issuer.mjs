// ABR-95: ephemeral authorization-code/PCKE fixture for offline tests ONLY.
// Never import into the bridge runtime: it does not authenticate real users.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from 'node:crypto';

const hash = x => createHash('sha256').update(x).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createLocalPkceIssuerFixture({
  issuer = 'https://test-idp.example.invalid',
  resource, allowedRedirects,
  now = () => Math.floor(Date.now() / 1000),
}) {
  if (!resource?.startsWith('https://') || !Array.isArray(allowedRedirects) || !allowedRedirects.length)
    throw TypeError('Explicit test resource and redirect allowlist required');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const kid = 'local-test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' };
  const clients = new Map(), authorizations = new Map(), refreshRecords = new Map();
  const revoked = new Set();

  function registerClient({ redirectUris }) {
    if (!Array.isArray(redirectUris) || !redirectUris.length ||
        redirectUris.some(u => !allowedRedirects.includes(u))) throw Error('REDIRECT_NOT_REGISTERABLE');
    const clientId = 'test-client-' + randomUUID();
    clients.set(clientId, new Set(redirectUris));
    return { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: 'none' };
  }
  function authorize({ clientId, redirectUri, state, scope, codeChallenge, method = 'S256',
    approved = false, subject = 'reviewer@example.invalid', requestedResource = resource }) {
    if (!clients.get(clientId)?.has(redirectUri)) throw Error('REDIRECT_MISMATCH');
    if (typeof state !== 'string' || state.length < 16) throw Error('CSRF_STATE_REQUIRED');
    if (method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge ?? ''))
      throw Error('PKCE_S256_REQUIRED');
    if (!approved) throw Error('CONSENT_REQUIRED');
    if (requestedResource !== resource) throw Error('WRONG_RESOURCE');
    const scopes = scope?.split(' ') ?? [];
    if (!scopes.length || scopes.some(s =>
      !['mcp:discover', 'mcp:read', 'offline_access'].includes(s)))
      throw Error('SCOPE_NOT_ALLOWED');
    const code = random();
    authorizations.set(hash(code), {
      clientId, redirectUri, codeChallenge, subject, scope,
      expires: now() + 90,
    });
    return { code, state, iss: issuer };
  }
  function signClaimsForTest(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const data = header + '.' + payload;
    const signature = sign('sha256', Buffer.from(data),
      { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return data + '.' + signature;
  }
  function issue({ clientId, subject, scope }) {
    const claims = {
      iss: issuer, aud: [resource], sub: subject, client_id: clientId,
      scope, iat: now(), nbf: now(), exp: now() + 300, jti: random(),
    };
    const refreshToken = random();
    refreshRecords.set(hash(refreshToken), { clientId, subject, scope, current: true });
    return { access_token: signClaimsForTest(claims), token_type: 'Bearer',
      expires_in: 300, scope, refresh_token: refreshToken };
  }
  function exchangeCode({ clientId, redirectUri, code, codeVerifier, requestedResource = resource }) {
    const entry = authorizations.get(hash(code ?? ''));
    if (!entry || entry.expires <= now() || entry.clientId !== clientId ||
        entry.redirectUri !== redirectUri || requestedResource !== resource ||
        typeof codeVerifier !== 'string' || codeVerifier.length < 43 || codeVerifier.length > 128 ||
        !safeEq(hash(codeVerifier), entry.codeChallenge)) throw Error('INVALID_GRANT');
    authorizations.delete(hash(code));
    return issue({ clientId, subject: entry.subject, scope: entry.scope });
  }
  function refresh({ refreshToken, clientId }) {
    const record = refreshRecords.get(hash(refreshToken ?? ''));
    if (!record || !record.current || record.clientId !== clientId) throw Error('INVALID_GRANT');
    record.current = false;
    return issue({ clientId, subject: record.subject, scope: record.scope });
  }
  function revoke(accessToken) {
    try {
      const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
      revoked.add(claims.jti);
    } catch { throw Error('INVALID_TOKEN'); }
  }
  function metadata() {
    return { issuer, authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token', registration_endpoint: issuer + '/register',
      revocation_endpoint: issuer + '/revoke', authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:discover', 'mcp:read', 'offline_access'] };
  }
  return Object.freeze({
    registerClient, authorize, exchangeCode, refresh, revoke,
    metadata, signClaimsForTest, jwks: { keys: [jwk] }, revoked,
  });
}
