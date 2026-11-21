// ABR-96 isolated terminal sessions. Handles are ephemeral for the current
// process. On host restart, old handles become unavailable (never replayed).
import { randomUUID } from 'node:crypto';
import { analyzeProcessState } from './process-state.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createTerminalSessions({ runner, authority, maxSessions = 8 }) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 64)
    throw TypeError('Invalid terminal capacity');
  const sessions = new Map();
  let closed = false;

  function find(scope, id, tool) {
    const session = sessions.get(id);
    if (!session) throw Error('SESSION_NOT_FOUND');
    authority.sameOwner(scope, session.ownerKey, tool, session.workspaceId);
    return session;
  }
  function state(session) {
    if (session.finished) return session.outcome.status;
    const stderr = session.handle.sanitize(session.handle.output.stderr.toString('utf8'));
    const stdout = session.handle.sanitize(session.handle.output.stdout.toString('utf8'));
    return analyzeProcessState({ stdout, stderr }).status;
  }
  function outputView(session, offset = 0, length = 100) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) ||
        length < 1 || length > 500) throw Error('INVALID_PAGINATION');
    // Each segment is appended in actual stdout/stderr arrival order.
    // Cursors index immutable segments, never mutable concatenated streams.
    const end = Math.min(session.segments.length, offset + length);
    const text = session.segments.slice(offset, end).map(entry => entry.text).join('');
    return { processId: session.id, status: state(session),
      output: session.handle.sanitize(text),
      nextOffset: end, totalSegments: session.segments.length,
      cursorUnit: 'segments',
      totalLines: session.handle.sanitize(session.segments.map(entry => entry.text).join(''))
        .split(/\r?\n/).length,
      truncated: session.segmentsOverflow ||
        session.handle.output.stdoutTruncated || session.handle.output.stderrTruncated,
      exitCode: session.outcome?.exitCode ?? null,
    };
  }
  function startProcess(scope, command, { durationMs = runner.maxDurationMs } = {}) {
    if (closed) throw Error('EXECUTOR_CLOSED');
    const activeCount = [...sessions.values()].filter(item => !item.finished).length;
    if (activeCount >= maxSessions) throw Error('SESSION_LIMIT');
    // Finished session output is briefly accessible, but bounded retention
    // prevents permanent exhaustion after repeated short-lived commands.
    for (const [pastId, past] of sessions) {
      if (sessions.size < maxSessions * 4) break;
      if (past.finished) sessions.delete(pastId);
    }
    const scopeInfo = authority.requireGrant(scope, 'start_process', command.workspaceId, command.write);
    const id = randomUUID();
    const segments = [];
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    let segmentsOverflow = false;
    const append = (kind, bytes) => {
      const text = decoders[kind].decode(bytes, { stream: true });
      if (!text) return;
      if (segments.length >= 4_096) {
        segmentsOverflow = true;
        const item = sessions.get(id);
        if (item) item.segmentsOverflow = true;
        return;
      }
      segments.push({ kind, text });
    };
    const handle = runner.spawnCommand(command, {
      durationMs, interactive: true, onChunk: append,
    });
    const item = { id, workspaceId: command.workspaceId, ownerKey: scopeInfo.scopeKey,
      scope, handle, outcome: null, finished: false, segments, segmentsOverflow };
    sessions.set(id, item);
    handle.completion.then(result => {
      for (const kind of ['stdout', 'stderr']) {
        const rest = decoders[kind].decode();
        if (rest && segments.length < 4_096) segments.push({ kind, text: rest });
      }
      item.finished = true;
      item.outcome = result;
    });
    return { processId: id, status: 'running' };
  }
  function readProcessOutput(scope, id, offset = 0, length = 100) {
    return outputView(find(scope, id, 'read_process_output'), offset, length);
  }
  async function interactWithProcess(scope, id, input, { waitMs = 140 } = {}) {
    const item = find(scope, id, 'interact_with_process');
    if (item.finished || item.handle.child.stdin.destroyed) throw Error('SESSION_CLOSED');
    if (typeof input !== 'string' || Buffer.byteLength(input) > 8_192
        || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 1_200)
      throw Error('INVALID_INTERACTION');
    await new Promise((resolve, reject) =>
      item.handle.child.stdin.write(input, error => error ? reject(error) : resolve()));
    if (waitMs) await sleep(waitMs);
    return outputView(item);
  }
  function forceTerminate(scope, id) {
    const item = find(scope, id, 'force_terminate');
    return { processId: id, terminated: item.handle.terminate('cancelled') };
  }
  function killProcess(scope, id, signal = 'SIGTERM') {
    if (!['SIGTERM', 'SIGKILL'].includes(signal)) throw Error('UNSUPPORTED_SIGNAL');
    const item = find(scope, id, 'kill_process');
    return { processId: id, terminated: item.handle.terminate('cancelled', signal) };
  }
  function listSessions(scope, workspaceId, tool = 'list_sessions') {
    authority.requireGrant(scope, tool, workspaceId);
    return [...sessions.values()].filter(item => {
      if (item.workspaceId !== workspaceId) return false;
      try { authority.sameOwner(scope, item.ownerKey, tool, workspaceId); return true; }
      catch { return false; }
    }).map(item => ({ processId: item.id, workspaceId, status: state(item) }));
  }
  function cancelScope(scope) {
    for (const session of sessions.values()) {
      if (session.scope === scope) session.handle.terminate('cancelled', 'SIGTERM');
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    for (const item of sessions.values()) item.handle.terminate('interrupted');
    await Promise.all([...sessions.values()].map(item => item.handle.completion));
    sessions.clear();
  }
  return Object.freeze({
    startProcess, readProcessOutput, interactWithProcess,
    forceTerminate, killProcess, listSessions, cancelScope,
    listProcesses: (scope, workspaceId) => listSessions(scope, workspaceId, 'list_processes'),
    close,
  });
}
