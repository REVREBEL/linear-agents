// ABR-94: isolated loopback MCP relay scaffold. ABR-95 owns OAuth/remote ingress.
// Independently implemented from a reviewed BRC architecture; no vendored tool code.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

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

export function createLocalMcpRelay({ clientToken, agentToken, deviceId, profile = 'core' }) {
  if (typeof clientToken !== 'string' || clientToken.length < 32 ||
      typeof agentToken !== 'string' || agentToken.length < 32 || clientToken === agentToken ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId ?? '') ||
      !['core', 'focused', 'full'].includes(profile)) throw TypeError('Invalid local relay configuration');
  const agents = new Map(); const pending = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  const server = createServer(async (req, res) => {
    if (!local(req)) return json(res, 403, { error: 'FORBIDDEN_ORIGIN' });
    if (req.url !== '/mcp' || req.method !== 'POST')
      return json(res, 404, { error: 'NOT_FOUND' });
    if (!authorized(req.headers.authorization, clientToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      return json(res, 401, { error: 'UNAUTHORIZED' });
    }
    if (!req.headers['content-type']?.startsWith('application/json'))
      return json(res, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
    let body;
    try { body = await parse(req); }
    catch (e) { return json(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: e.message }); }
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      return json(res, 400, { error: 'INVALID_JSONRPC' });
    if (body.method === 'notifications/initialized' && body.id === undefined) {
      res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end();
    }
    if (!['string', 'number'].includes(typeof body.id))
      return json(res, 400, { error: 'MISSING_JSONRPC_ID' });
    let result; let error;
    if (body.method === 'initialize') {
      if (body.params?.protocolVersion && body.params.protocolVersion !== VERSION)
        error = { code: -32602, message: 'UNSUPPORTED_PROTOCOL_VERSION' };
      else result = { protocolVersion: VERSION, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'revrebel-mcp-local-foundation', version: '0.1.0' } };
    } else if (body.method === 'ping') result = {};
    else if (body.method === 'tools/list') result = { tools: TOOL_LIST };
    else if (body.method === 'tools/call') {
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
    return json(res, 200, error ? { jsonrpc: '2.0', id: body.id, error } :
      { jsonrpc: '2.0', id: body.id, result });
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
