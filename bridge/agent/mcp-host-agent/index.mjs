// ABR-94: read-only outbound host fixture; no commands, uploads or plugins.
// ABR-96 will implement the OS sandboxed privileged executor.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';

const MAX_FILE_BYTES = 262_144;
function under(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}
export async function connectLocalHostAgent({ endpoint, agentToken, deviceId, workspace }) {
  if (typeof endpoint !== 'string' || !/^ws:\/\/(127\.0\.0\.1|localhost):\d+\/agent$/.test(endpoint))
    throw TypeError('Only the local loopback agent endpoint is accepted');
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace))
    throw TypeError('An absolute approved workspace is required');
  if (typeof agentToken !== 'string' || agentToken.length < 32 ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId ?? '')) throw TypeError('Missing local pairing identity');
  const root = await realpath(workspace);
  if (root === path.parse(root).root) throw TypeError('Filesystem root is not an allowed workspace');
  if (!(await stat(root)).isDirectory()) throw TypeError('Workspace is not a directory');
  const socket = new WebSocket(endpoint, [], {
    headers: { Authorization: 'Bearer ' + agentToken, 'X-Agent-Device': deviceId },
    perMessageDeflate: false,
    handshakeTimeout: 3_000,
    maxPayload: MAX_FILE_BYTES + 1_024,
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, res) => reject(Error('Pairing rejected: ' + res.statusCode)));
  });
  socket.on('message', async (bytes) => {
    let request;
    try { request = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (request?.type !== 'call' || typeof request.id !== 'string') return;
    const response = { type: 'result', id: request.id, ok: false, error: 'UNKNOWN_OR_UNAUTHORIZED_TOOL' };
    if (request.tool === 'read_file') {
      let file;
      try {
        const input = request.args?.path;
        if (typeof input !== 'string' || input.length < 1 || input.length > 4_096 ||
            input.includes('\0')) throw Error('INVALID_PATH');
        const candidate = path.resolve(root, input);
        if (!under(root, candidate)) throw Error('OUTSIDE_AUTHORIZED_WORKSPACE');
        const absolute = await realpath(candidate);
        if (!under(root, absolute)) throw Error('OUTSIDE_AUTHORIZED_WORKSPACE');
        file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await file.stat();
        if (!info.isFile()) throw Error('NOT_A_REGULAR_FILE');
        if (info.size > MAX_FILE_BYTES) throw Error('FILE_TOO_LARGE');
        const buffer = await file.readFile();
        const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        const lines = body.split(/\r?\n/);
        const offset = request.args?.offset ?? 0;
        const length = request.args?.length ?? 1_000;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) ||
            length < 1 || length > 1_000) throw Error('INVALID_PAGINATION');
        response.ok = true;
        response.text = JSON.stringify({
          path: input, content: lines.slice(offset, offset + length).join('\n'),
          offset, totalLines: lines.length, sha256: createHash('sha256').update(buffer).digest('hex'),
        });
        delete response.error;
      } catch (error) {
        response.error = ['INVALID_PATH', 'OUTSIDE_AUTHORIZED_WORKSPACE', 'NOT_A_REGULAR_FILE',
          'FILE_TOO_LARGE', 'INVALID_PAGINATION'].includes(error.message)
          ? error.message : 'READ_FAILED';
      } finally { await file?.close(); }
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  });
  return {
    socket,
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => {
        socket.once('close', resolve);
        socket.close(1000, 'closed');
      });
    },
  };
}
