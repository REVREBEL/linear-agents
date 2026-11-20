// ABR-95: two explicitly separated MCP wire eras, read-only tools only.
// Latest spec source: modelcontextprotocol.io/specification/2026-07-28.
// This local harness implements the covered subset; full SDK interop is a
// separate ABR-100 live client acceptance requirement.
export const MODERN = '2026-07-28';
export const LEGACY = new Set(['2025-06-18', '2025-11-25']);
export const PROTOCOL_CODES = Object.freeze({
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
  METHOD_NOT_FOUND: -32601,
});

const PROTOCOL_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

function failure(code, message) {
  return { ok: false, code, message, status: 400 };
}
export function classifyMcpRequest(req, body) {
  const params = body?.params;
  const meta = params && typeof params === 'object' ? params._meta : null;
  const envelopeVersion = meta?.[PROTOCOL_META];
  const headerVersion = req.headers['mcp-protocol-version'];
  const modern = envelopeVersion === MODERN || headerVersion === MODERN
    || body?.method === 'server/discover';
  if (modern) {
    if (headerVersion && envelopeVersion && headerVersion === envelopeVersion
        && headerVersion !== MODERN) {
      return failure(PROTOCOL_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'UnsupportedProtocolVersion');
    }
    if (headerVersion !== MODERN || envelopeVersion !== MODERN) {
      return failure(PROTOCOL_CODES.HEADER_MISMATCH, 'HeaderMismatch');
    }
    if (req.headers['mcp-method'] !== body.method
        || (meta?.[CLIENT_INFO] !== undefined &&
          (typeof meta[CLIENT_INFO]?.name !== 'string' ||
           typeof meta[CLIENT_INFO]?.version !== 'string'))
        || !meta?.[CLIENT_CAPABILITIES] || typeof meta[CLIENT_CAPABILITIES] !== 'object') {
      return failure(PROTOCOL_CODES.HEADER_MISMATCH, 'HeaderMismatch');
    }
    const named = body.method === 'tools/call';
    if (named && req.headers['mcp-name'] !== params?.name) {
      return failure(PROTOCOL_CODES.HEADER_MISMATCH, 'HeaderMismatch');
    }
    if (!named && req.headers['mcp-name'] !== undefined) {
      return failure(PROTOCOL_CODES.HEADER_MISMATCH, 'HeaderMismatch');
    }
    return { ok: true, era: 'modern', protocolVersion: MODERN };
  }

  if (envelopeVersion && !LEGACY.has(envelopeVersion)) {
    return failure(PROTOCOL_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'UnsupportedProtocolVersion');
  }
  if (headerVersion && !LEGACY.has(headerVersion)) {
    return failure(PROTOCOL_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'UnsupportedProtocolVersion');
  }
  if (headerVersion && envelopeVersion && headerVersion !== envelopeVersion) {
    return failure(PROTOCOL_CODES.HEADER_MISMATCH, 'HeaderMismatch');
  }
  if (body.method === 'initialize') {
    const version = params?.protocolVersion;
    if (!LEGACY.has(version)) {
      return failure(PROTOCOL_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'UnsupportedProtocolVersion');
    }
    if (headerVersion && headerVersion !== version) {
      return failure(PROTOCOL_CODES.HEADER_MISMATCH, 'HeaderMismatch');
    }
    return { ok: true, era: 'legacy', protocolVersion: version };
  }
  // A 2025-era tool call can declare its version through a header, or
  // inherit the server's default compatibility fixture version when absent.
  return { ok: true, era: 'legacy', protocolVersion: headerVersion ?? '2025-06-18' };
}

export function modernResult(result, era, method) {
  if (era !== 'modern' || !result) return result;
  const decorated = { ...result, resultType: 'complete',
    _meta: { ...(result._meta ?? {}),
      'io.modelcontextprotocol/serverInfo':
        { name: 'revrebel-mcp-local-foundation', version: '0.2.0' } } };
  if (method === 'server/discover' || method === 'tools/list') {
    decorated.ttlMs = 0;
    decorated.cacheScope = 'private';
  }
  return decorated;
}
