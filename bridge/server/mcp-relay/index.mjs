// ABR-94: isolated loopback MCP relay scaffold. ABR-95 owns OAuth/remote ingress.
// Independently implemented from a reviewed BRC architecture; no vendored tool code.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { classifyMcpRequest, modernResult, MODERN } from './protocol-compat.mjs';

const VERSION = '2025-06-18'; // Minimal local smoke only; protocol matrix belongs to ABR-95.
const LIMIT = 65_536;
const SCHEMA = {
  read_file: { type: 'object', required: ['deviceId', 'path'], additionalProperties: false,
    properties: { deviceId: { type: 'string' }, path: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1, maximum: 1_000 } } },
  list_devices: { type: 'object', properties: {}, additionalProperties: false },
};
const TOOL_LIST = [
  { name: 'list_devices', description: 'List the operator-approved local fixture device.', inputSchema: SCHEMA.list_devices },
  { name: 'read_file', description: 'Read UTF-8 file bytes in the paired device allowlist.', inputSchema: SCHEMA.read_file },
];
function authorized(header, secret) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function local(req) {
  if (!/^127\.0\.0\.1(:\d{1,5})?$/.test(req.headers.host ?? '')) return false;
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return origin.protocol === 'http:' && origin.hostname === '127.0.0.1'
      && origin.port === (req.headers.host?.split(':')[1] ?? '');
  } catch { return false; }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function toolError(code) { return { isError: true, content: [{ type: 'text', text: code }] }; }
function validReadArgs(a) {
  return a && typeof a === 'object' && !Array.isArray(a)
    && typeof a.deviceId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(a.deviceId)
    && typeof a.path === 'string' && a.path.length > 0 && a.path.length < 4_096
    && (a.offset === undefined || Number.isInteger(a.offset) && a.offset >= 0)
    && (a.length === undefined || Number.isInteger(a.length) && a.length >= 1 && a.length <= 1_000)
    && Object.keys(a).every((k) => Object.hasOwn(SCHEMA.read_file.properties, k));
}
async function parse(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('INVALID_JSON'); }
}
function rejectSocket(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createLocalMcpRelay({
  clientToken, agentToken, deviceId, profile = 'core',
  oauthResource = null, toolProfileBinding = null,
}) {
  if ((!oauthResource && (typeof clientToken !== 'string' || clientToken.length < 32)) ||
      (oauthResource && (typeof oauthResource.validateBearer !== 'function' ||
        typeof oauthResource.protectedMetadata !== 'function')) ||
      typeof agentToken !== 'string' || agentToken.length < 32 || (!oauthResource && clientToken === agentToken) ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId ?? '') ||
      !['core', 'focused', 'full'].includes(profile)) throw TypeError('Invalid local relay configuration');
  // Expanded handlers cannot be used with the legacy static shared bearer.
  if (toolProfileBinding && (!oauthResource ||
      typeof toolProfileBinding.gateway?.listTools !== 'function' ||
      typeof toolProfileBinding.gateway?.invoke !== 'function' ||
      typeof toolProfileBinding.resolveVerifiedHandle !== 'function'))
    throw TypeError('EXPANDED_TOOLS_REQUIRE_TRUSTED_OAUTH_BINDING');
  const agents = new Map(); const pending = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  const server = createServer(async (req, res) => {
    if (!local(req)) return json(res, 403, { error: 'FORBIDDEN_ORIGIN' });
    // The authorization resource metadata is public, but tools never are.
    // Never infer the issuer or public URL from untrusted forwarding headers.
    if (oauthResource && req.method === 'GET'
        && (req.url === '/.well-known/oauth-protected-resource'
          || req.url === '/.well-known/oauth-protected-resource/mcp')) {
      return json(res, 200, oauthResource.protectedMetadata());
    }
    if (oauthResource && req.url === '/mcp' &&
        ['GET', 'DELETE'].includes(req.method)) {
      return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (req.url !== '/mcp' || req.method !== 'POST')
      return json(res, 404, { error: 'NOT_FOUND' });
    if (oauthResource && ['forwarded', 'x-forwarded-host', 'x-forwarded-proto']
      .some((header) => req.headers[header] !== undefined)) {
      return json(res, 403, { error: 'UNTRUSTED_PROXY_HEADERS' });
    }
    const principal = oauthResource
      ? oauthResource.validateBearer(req.headers.authorization)
      : { ok: authorized(req.headers.authorization, clientToken) };
    if (!principal.ok) {
      const scopeDenied = oauthResource &&
        ['INSUFFICIENT_SCOPE', 'PRINCIPAL_NOT_AUTHORIZED'].includes(principal.code);
      if (oauthResource) {
        res.setHeader('WWW-Authenticate',
          `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', oauthResource.audience).href}", scope="mcp:discover", error="${scopeDenied ? 'insufficient_scope' : 'invalid_token'}"`);
      } else res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      return json(res, scopeDenied ? 403 : 401,
        { error: scopeDenied ? principal.code : 'UNAUTHORIZED' });
    }
    if (!req.headers['content-type']?.startsWith('application/json'))
      return json(res, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
    let body;
    try { body = await parse(req); }
    catch (e) { return json(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: e.message }); }
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      return json(res, 400, { error: 'INVALID_JSONRPC' });
    const wire = oauthResource ? classifyMcpRequest(req, body) :
      { ok: true, era: 'legacy', protocolVersion: VERSION };
    if (oauthResource && wire.era === 'modern' &&
        !req.headers.accept?.includes('application/json') ||
        oauthResource && wire.era === 'modern' &&
        !req.headers.accept?.includes('text/event-stream')) {
      return json(res, 406, { error: 'NOT_ACCEPTABLE' });
    }
    if (!wire.ok) {
      return json(res, wire.status, { jsonrpc: '2.0', id: body.id ?? null,
        error: { code: wire.code, message: wire.message,
          ...(wire.code === -32022 ? { data: {
            supported: [MODERN, '2025-11-25', '2025-06-18'],
            requested: req.headers['mcp-protocol-version'] ?? body.params?.protocolVersion ?? null,
          } } : {}) } });
    }
    if (body.method === 'notifications/initialized' && body.id === undefined
        && wire.era === 'legacy') {
      res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end();
    }
    if (!['string', 'number'].includes(typeof body.id))
      return json(res, 400, { error: 'MISSING_JSONRPC_ID' });
    let result; let error;
    if (body.method === 'server/discover' && wire.era === 'modern') {
      result = { supportedVersions: [MODERN, '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} } };
    } else if (body.method === 'initialize' && wire.era === 'legacy') {
      if (body.params?.protocolVersion && !oauthResource &&
          body.params.protocolVersion !== VERSION)
        error = { code: -32602, message: 'UNSUPPORTED_PROTOCOL_VERSION' };
      else result = { protocolVersion: wire.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'revrebel-mcp-local-foundation', version: '0.2.0' } };
    } else if (body.method === 'ping') result = {};
    else if (body.method === 'tools/list' && toolProfileBinding) {
      try {
        const handle = toolProfileBinding.resolveVerifiedHandle(principal);
        result = { tools: toolProfileBinding.gateway.listTools(handle)
          .filter(tool => oauthResource.validateBearer(req.headers.authorization, {
            tool: tool.name, deviceId,
          }).ok) };
      } catch {
        return json(res, 403, { error: 'TOOL_SESSION_NOT_AUTHORIZED' });
      }
    } else if (body.method === 'tools/list') {
      result = { tools: oauthResource
        ? TOOL_LIST.filter((tool) => principal.tools.has(tool.name) &&
          principal.scopes.has(tool.name === 'read_file' ? 'mcp:read' : 'mcp:discover'))
        : TOOL_LIST };
    } else if (body.method === 'tools/call' && toolProfileBinding) {
      const name = body.params?.name;
      if (typeof name !== 'string' || name.length > 128) {
        error = { code: -32602, message: 'INVALID_TOOL_NAME' };
      } else {
        const checked = oauthResource.validateBearer(req.headers.authorization, {
          tool: name, deviceId,
        });
        if (!checked.ok) {
          res.setHeader('WWW-Authenticate', 'Bearer error="insufficient_scope"');
          return json(res, 403, { error: checked.code });
        }
        try {
          const handle = toolProfileBinding.resolveVerifiedHandle(checked);
          const value = await toolProfileBinding.gateway.invoke(
            handle, name, body.params?.arguments ?? {});
          result = { isError: false, content: [
            { type: 'text', text: JSON.stringify(value) },
          ] };
        } catch (caught) {
          const code = ['INVALID_PARAMS', 'TOOL_NOT_AUTHORIZED',
            'UNAUTHORIZED_TOOL_SESSION'].includes(caught?.message)
            ? caught.message : 'TOOL_EXECUTION_FAILED';
          result = toolError(code);
        }
      }
    } else if (body.method === 'tools/call') {
      if (oauthResource && ['read_file', 'list_devices'].includes(body.params?.name)) {
        const checked = oauthResource.validateBearer(req.headers.authorization, {
          tool: body.params.name, deviceId: body.params.arguments?.deviceId ??
            (body.params.name === 'list_devices' ? deviceId : null),
        });
        if (!checked.ok) {
          res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${
            body.params.name === 'read_file' ? 'mcp:read' : 'mcp:discover'}"`);
          return json(res, 403, { error: checked.code });
        }
      }
      if (body.params?.name === 'list_devices') {
        if (Object.keys(body.params.arguments ?? {}).length)
          error = { code: -32602, message: 'INVALID_PARAMS' };
        else result = { content: [{ type: 'text',
          text: JSON.stringify([{ id: deviceId, online: agents.has(deviceId) }]) }] };
      } else if (body.params?.name !== 'read_file') result = toolError('UNKNOWN_OR_UNAUTHORIZED_TOOL');
      else if (!validReadArgs(body.params.arguments)) error = { code: -32602, message: 'INVALID_PARAMS' };
      else if (body.params.arguments.deviceId !== deviceId) result = toolError('DEVICE_NOT_AUTHORIZED');
      else {
        const socket = agents.get(deviceId);
        if (!socket || socket.readyState !== WebSocket.OPEN) result = toolError('DEVICE_OFFLINE');
        else result = await new Promise((resolve) => {
          const id = randomUUID();
          const timeout = setTimeout(() => { pending.delete(id); resolve(toolError('DEVICE_TIMEOUT')); }, 3_000);
          pending.set(id, { resolve, timeout });
          try { socket.send(JSON.stringify({ type: 'call', id, tool: 'read_file',
            args: { path: body.params.arguments.path, offset: body.params.arguments.offset,
              length: body.params.arguments.length } })); }
          catch { pending.delete(id); clearTimeout(timeout); resolve(toolError('DEVICE_DISCONNECTED')); }
        });
      }
    } else error = { code: -32601, message: 'METHOD_NOT_FOUND' };
    return json(res, error && wire.era === 'modern' ?
      (error.code === -32601 ? 404 : 400) : 200,
      error ? { jsonrpc: '2.0', id: body.id, error } :
        { jsonrpc: '2.0', id: body.id, result: modernResult(result, wire.era, body.method) });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!local(req) || req.url !== '/agent') return rejectSocket(socket, '403 Forbidden');
    if (!authorized(req.headers.authorization, agentToken) ||
        req.headers['x-agent-device'] !== deviceId) return rejectSocket(socket, '401 Unauthorized');
    if (agents.has(deviceId)) return rejectSocket(socket, '409 Conflict');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    agents.set(deviceId, ws);
    // A paired host can still send malformed/oversized frames. Treat WS errors
    // as disconnects; an unhandled EventEmitter error must never kill the relay.
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (message?.type !== 'result' || typeof message.id !== 'string') return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timeout);
      item.resolve(message.ok && typeof message.text === 'string'
        ? { isError: false, content: [{ type: 'text', text: message.text }] }
        : toolError(typeof message.error === 'string' ? message.error : 'DEVICE_ERROR'));
    });
    ws.on('close', () => {
      if (agents.get(deviceId) === ws) agents.delete(deviceId);
      for (const [id, item] of pending) {
        pending.delete(id); clearTimeout(item.timeout); item.resolve(toolError('DEVICE_DISCONNECTED'));
      }
    });
  });
  return {
    async listen() {
      if (server.listening) throw Error('Already listening');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      for (const ws of agents.values()) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
    get address() { return server.address(); },
  };
}
