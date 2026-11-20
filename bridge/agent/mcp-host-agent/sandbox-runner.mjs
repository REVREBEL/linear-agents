// ABR-96 Linux bubblewrap runner: no host shell, untrusted env, network,
// sensitive files, or host /proc. The sole mounted project directory is an
// operator-approved, fd-pinned workspace. The sandbox is REQUIRED (fail closed).
import { spawn, spawnSync } from 'node:child_process';
import {
  openSync, closeSync, constants, realpathSync, lstatSync, statSync,
} from 'node:fs';
import path from 'node:path';

const BWRAP = '/usr/bin/bwrap';
const PRLIMIT = '/usr/bin/prlimit';
const PROGRAMS = Object.freeze({
  python3: '/usr/bin/python3',
  git: '/usr/bin/git',
  bash: '/usr/bin/bash',
});
const MAX_ARG = 32 * 1024;
export const MAX_CAPTURE = 128 * 1024;

function beneath(parent, candidate) {
  return candidate === parent || candidate.startsWith(parent + path.sep);
}
function recordRoot(root) {
  const canonical = realpathSync(root);
  const stats = statSync(canonical);
  if (!stats.isDirectory() || canonical === '/' || lstatSync(canonical).isSymbolicLink())
    throw TypeError('An approved non-root real directory is required');
  return Object.freeze({ path: canonical, dev: stats.dev, ino: stats.ino });
}
function validateCwd(workspaceRoot, requested = '.') {
  if (typeof requested !== 'string' || requested.length > 2_048 ||
      requested.includes('\0')) throw Error('INVALID_CWD');
  const candidate = realpathSync(path.resolve(workspaceRoot.path, requested));
  if (!beneath(workspaceRoot.path, candidate) || !statSync(candidate).isDirectory())
    throw Error('WORKSPACE_ESCAPE');
  const relative = path.relative(workspaceRoot.path, candidate);
  return relative ? '/workspace/' + relative.split(path.sep).join('/') : '/workspace';
}
function capBytes(value, limit = MAX_ARG) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= limit
    && !value.includes('\0');
}
export function validateCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)
      || !Object.hasOwn(PROGRAMS, command.program)
      || !Array.isArray(command.args) || command.args.length > 96
      || !command.args.every(arg => capBytes(arg))
      || Object.keys(command).some(key => ![
        'program', 'args', 'cwd', 'write', 'workspaceId',
      ].includes(key))) throw Error('INVALID_COMMAND');
  return Object.freeze({
    workspaceId: command.workspaceId,
    program: command.program,
    args: [...command.args],
    cwd: command.cwd ?? '.',
    write: command.write === true,
  });
}
function assertSafeSource(root) {
  const fd = openSync(root.path, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = statSync('/proc/self/fd/' + fd);
    if (actual.dev !== root.dev || actual.ino !== root.ino) throw Error('WORKSPACE_CHANGED');
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}
export function assertSandboxSupported() {
  if (process.platform !== 'linux') throw Error('SANDBOX_UNAVAILABLE: linux required');
  if (!statSync(BWRAP).isFile() || !statSync(PRLIMIT).isFile()) {
    throw Error('SANDBOX_UNAVAILABLE: bubblewrap and prlimit required');
  }
}
export function probeSandbox() {
  try {
    assertSandboxSupported();
    const result = spawnSync(BWRAP, [
      '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
      '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--', '/usr/bin/python3', '-c', 'print("SANDBOX_OK")',
    ], { encoding: 'utf8', timeout: 3_000,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' } });
    return {
      available: result.status === 0 && result.stdout.trim() === 'SANDBOX_OK',
      error: result.status === 0 ? null : (result.error?.message ?? result.stderr.trim()).slice(0, 360),
      uid: process.getuid?.(),
    };
  } catch (error) {
    return { available: false, error: String(error.message).slice(0, 360), uid: process.getuid?.() };
  }
}
export function createSandboxRunner({ projectsRoot, workspaces, expectedUid = process.getuid?.(),
  secrets = [], maxDurationMs = 15_000, maxConcurrent = 2,
  allowRootForIsolatedTests = false }) {
  assertSandboxSupported();
  if (!Number.isInteger(expectedUid) || expectedUid !== process.getuid?.()) {
    throw Error('UNEXPECTED_OS_PRINCIPAL');
  }
  if (process.getuid?.() === 0 && allowRootForIsolatedTests !== true) {
    throw Error('ROOT_PRINCIPAL_DENIED');
  }
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 200 || maxDurationMs > 120_000 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8)
    throw TypeError('Invalid executor limits');
  const root = recordRoot(projectsRoot);
  const allowed = new Map();
  for (const [id, workspace] of Object.entries(workspaces ?? {})) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw TypeError('Invalid workspace identity');
    const entry = recordRoot(workspace);
    if (!beneath(root.path, entry.path) || entry.path === root.path) {
      throw Error('WORKSPACE_OUTSIDE_PROJECTS_ROOT');
    }
    allowed.set(id, entry);
  }
  if (!allowed.size) throw TypeError('At least one authorized workspace required');
  if (!Array.isArray(secrets) || secrets.some(x => typeof x !== 'string'))
    throw TypeError('Secrets must be an explicit operator configuration');

  function sanitize(value) {
    let text = String(value);
    // The secret fixtures and dynamic provider credentials are not allowed to
    // pass through stdout/stderr/SQLite. This is NOT an exhaustive DLP system.
    for (const secret of secrets.filter(x => x.length >= 4))
      text = text.split(secret).join('[REDACTED]');
    return text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}\b/gi, 'Bearer [REDACTED]')
      .replace(/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD))=\S+/g, '$1=[REDACTED]')
      .replace(/\bop:\/\/[^\s"'<>]+/g, 'op://[REDACTED]');
  }

  function spawnCommand(command, { onChunk, onExit, durationMs = maxDurationMs, interactive = false } = {}) {
    const req = validateCommand(command);
    if (typeof req.workspaceId !== 'string' || !allowed.has(req.workspaceId))
      throw Error('WORKSPACE_NOT_AUTHORIZED');
    const workspace = allowed.get(req.workspaceId);
    // Runtime check is scoped to the actual configured service principal.
    const probe = probeSandbox();
    if (!probe.available) throw Error('SANDBOX_UNAVAILABLE: ' + probe.error);
    const cwd = validateCwd(workspace, req.cwd);
    if (!Number.isInteger(durationMs) || durationMs < 200 || durationMs > maxDurationMs)
      throw Error('INVALID_TIMEOUT');
    const fd = assertSafeSource(workspace);
    let child;
    try {
      // Note: FD 3 is an *opened directory* (not a newly resolved pathname).
      // Even a parent symlink swap between check and spawn cannot retarget it.
      const bindings = [
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
        req.write ? '--bind-fd' : '--ro-bind-fd', '3', '/workspace',
      ];
      const args = [
        '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
        '--unshare-uts', '--die-with-parent', '--new-session',
        ...bindings, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'HOME', '/tmp',
        '--chdir', cwd,
        '--', PROGRAMS[req.program], ...req.args,
      ];
      child = spawn(PRLIMIT, [
        '--cpu=' + Math.ceil(durationMs / 1000 + 2),
        '--as=' + (1024 * 1024 * 1024),
        '--fsize=' + (16 * 1024 * 1024),
        '--nofile=128', '--', BWRAP, ...args,
      ], { cwd: '/',
        stdio: ['pipe', 'pipe', 'pipe', fd], detached: true,
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8', PYTHONUNBUFFERED: '1' } });
    } finally { closeSync(fd); }

    const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      stdoutTruncated: false, stderrTruncated: false };
    let timeout, finished = false, disposition;
    const accumulate = (kind, chunk) => {
      const room = MAX_CAPTURE - output[kind].length;
      if (room > 0) output[kind] = Buffer.concat([output[kind], chunk.subarray(0, room)]);
      if (chunk.length > room) output[kind + 'Truncated'] = true;
      onChunk?.(kind);
    };
    child.stdout.on('data', bytes => accumulate('stdout', bytes));
    child.stderr.on('data', bytes => accumulate('stderr', bytes));
    function terminate(reason = 'cancelled', signal = 'SIGKILL') {
      if (finished) return false;
      disposition = reason;
      try { process.kill(-child.pid, signal); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      if (signal === 'SIGTERM') {
        setTimeout(() => {
          if (!finished) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        }, 200).unref();
      }
      return true;
    }
    const completion = new Promise(resolve => {
      child.once('error', error => {
        // Node emits 'close' after 'error'; just record a controlled failure.
        if (!disposition) disposition = 'failed';
        accumulate('stderr', Buffer.from(String(error.message)));
      });
      child.once('close', (code, signal) => {
        finished = true;
        clearTimeout(timeout);
        const status = disposition ??
          (code === 0 ? 'completed' : 'failed');
        const value = {
          status, exitCode: Number.isInteger(code) ? code : null,
          signal: signal ?? null,
          stdout: sanitize(output.stdout.toString('utf8')),
          stderr: sanitize(output.stderr.toString('utf8')),
          stdoutTruncated: output.stdoutTruncated,
          stderrTruncated: output.stderrTruncated,
        };
        onExit?.(value);
        resolve(value);
      });
    });
    timeout = setTimeout(() => terminate('timed_out'), durationMs);
    timeout.unref();
    if (!interactive) child.stdin.end();
    return { child, completion, terminate, output, sanitize, getStatus: () => disposition ?? (finished ? 'finished' : 'running') };
  }
  return Object.freeze({
    workspaces: Object.freeze([...allowed.keys()]),
    maxConcurrent, maxDurationMs, spawnCommand, sanitize, probeSandbox,
  });
}
