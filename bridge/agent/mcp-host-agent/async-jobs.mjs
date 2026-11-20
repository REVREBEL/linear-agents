// ABR-96: SQLite-only execution outcome journal, NOT Bridge's authoritative
// Linear job ledger. All records are device/session-scoped, idempotent and
// subject to the server-owned execution-authority capability on every call.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, chmodSync, readFileSync,
  openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { validateCommand } from './sandbox-runner.mjs';

const FINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const KEY = /^[a-zA-Z0-9_.:-]{12,128}$/;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

function acquireLease(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(file, 'utf8').trim());
      if (!Number.isInteger(owner) || owner < 1)
        throw Error('INVALID_EXECUTOR_LEASE');
      let alive = true;
      try { process.kill(owner, 0); }
      catch (err) { if (err.code === 'ESRCH') alive = false; else throw err; }
      if (alive) throw Error('EXECUTOR_ALREADY_RUNNING');
      // Only reclaim an unmistakably dead owner; never break a live lease.
      unlinkSync(file);
    }
  }
  throw Error('EXECUTOR_ALREADY_RUNNING');
}
function persistConfig(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw Error('UNSAFE_EXECUTOR_JOURNAL');
  chmodSync(root, 0o700);
}

export function createExecutionJobs({ runner, authority, journalDir, onAudit = () => {},
  maxQueued = 32, maxHistory = 2_000, now = () => Date.now() }) {
  if (!runner || !authority || !path.isAbsolute(journalDir ?? '')
      || !Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 256
      || !Number.isInteger(maxHistory) || maxHistory < 1 || maxHistory > 100_000)
    throw TypeError('Runner, trusted authority, journal directory and bounded queue required');
  persistConfig(journalDir);
  const leaseFile = path.join(journalDir, 'executor.lock');
  const lease = acquireLease(leaseFile);
  let db;
  try {
    db = new DatabaseSync(path.join(journalDir, 'outcomes.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
    db.exec(`CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      duration_ms INTEGER,
      exit_code INTEGER,
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      stdout_truncated INTEGER NOT NULL DEFAULT 0,
      stderr_truncated INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      UNIQUE(owner_key, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_owner ON executions(owner_key, created_at DESC);`);
    // A crash must never silently reissue queued/running commands.
    db.prepare("UPDATE executions SET state='interrupted', finished_at=?, error_code='HOST_RESTART' WHERE state IN ('queued','running')")
      .run(now());
    // Directory is 0700 already. Defense in depth for a future narrower
    // process sandbox or journal migration to a shared parent.
    chmodSync(path.join(journalDir, 'outcomes.sqlite'), 0o600);
  } catch (error) {
    db?.close();
    closeSync(lease);
    unlinkSync(leaseFile);
    throw error;
  }
  const historyCount = db.prepare('SELECT COUNT(*) AS count FROM executions');
  const insert = db.prepare(`INSERT INTO executions (
    id, owner_key, workspace_id, idempotency_key, fingerprint, state, created_at, duration_ms
  ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`);
  const byOwnerKey = db.prepare('SELECT * FROM executions WHERE owner_key=? AND idempotency_key=?');
  const byId = db.prepare('SELECT * FROM executions WHERE id=?');
  const listByOwner = db.prepare('SELECT * FROM executions WHERE owner_key=? ORDER BY created_at DESC LIMIT ?');
  const statusRunning = db.prepare("UPDATE executions SET state='running', started_at=? WHERE id=? AND state='queued'");
  const complete = db.prepare(`UPDATE executions SET
    state=?, finished_at=?, exit_code=?, stdout=?, stderr=?,
    stdout_truncated=?, stderr_truncated=?, error_code=?
    WHERE id=? AND state IN ('queued','running')`);
  const pending = [];
  const running = new Map();
  const runningScopes = new Map();
  let lastScheduledOwner = null;
  let closed = false;
  let active = 0;

  function view(row) {
    if (!row) return null;
    return Object.freeze({
      jobId: row.id, workspaceId: row.workspace_id,
      state: row.state, createdAt: row.created_at, startedAt: row.started_at,
      finishedAt: row.finished_at, exitCode: row.exit_code,
      stdout: row.stdout, stderr: row.stderr,
      stdoutTruncated: Boolean(row.stdout_truncated),
      stderrTruncated: Boolean(row.stderr_truncated),
      errorCode: row.error_code,
    });
  }
  function writeOutcome(id, result) {
    const row = byId.get(id);
    if (!row || FINAL.has(row.state)) return;
    complete.run(result.status, now(), result.exitCode ?? null,
      runner.sanitize(result.stdout ?? ''), runner.sanitize(result.stderr ?? ''),
      Number(result.stdoutTruncated === true), Number(result.stderrTruncated === true),
      result.errorCode ?? null, id);
    onAudit({ event: 'execution_finished', jobId: id,
      state: result.status, workspaceId: row.workspace_id });
  }
  function pump() {
    if (closed) return;
    while (active < runner.maxConcurrent && pending.length) {
      // Use per-principal round robin whenever multiple principals are
      // queued; a single noisy session cannot indefinitely starve others.
      let index = pending.findIndex(task => task.scopeKey !== lastScheduledOwner);
      if (index < 0) index = 0;
      const [task] = pending.splice(index, 1);
      if (byId.get(task.id)?.state !== 'queued') continue;
      lastScheduledOwner = task.scopeKey;
      // Admission was valid on enqueue, but could expire or be revoked
      // while this task waits behind other users. Recheck immediately
      // before any process is spawned, including write permission.
      try {
        authority.requireGrant(task.scope, task.tool,
          task.command.workspaceId, task.command.write);
      } catch {
        writeOutcome(task.id, {
          status: 'failed', exitCode: null, errorCode: 'EXECUTION_NOT_AUTHORIZED',
        });
        continue;
      }
      statusRunning.run(now(), task.id);
      onAudit({ event: 'execution_started', jobId: task.id,
        workspaceId: task.command.workspaceId });
      let handle;
      try {
        handle = runner.spawnCommand(task.command, {
          durationMs: task.durationMs,
        });
      } catch (e) {
        writeOutcome(task.id, {
          status: 'failed', exitCode: null, errorCode:
            String(e.message).startsWith('SANDBOX_UNAVAILABLE') ? 'SANDBOX_UNAVAILABLE' : 'EXECUTION_FAILED',
        });
        continue;
      }
      active++;
      running.set(task.id, handle);
      runningScopes.set(task.id, task.scope);
      handle.completion.then((outcome) => {
        running.delete(task.id);
        runningScopes.delete(task.id);
        active--;
        if (!closed) writeOutcome(task.id, outcome);
        else writeOutcome(task.id, { ...outcome, status: 'interrupted', errorCode: 'EXECUTOR_STOPPED' });
        pump();
      });
    }
  }
  function enqueue(scope, tool, commandInput, { idempotencyKey, durationMs = runner.maxDurationMs } = {}) {
    if (closed) throw Error('EXECUTOR_CLOSED');
    const command = validateCommand(commandInput);
    const identity = authority.requireGrant(scope, tool, command.workspaceId, command.write);
    if (!KEY.test(idempotencyKey ?? '')) throw Error('IDEMPOTENCY_KEY_REQUIRED');
    if (!Number.isInteger(durationMs) || durationMs < 200 || durationMs > runner.maxDurationMs)
      throw Error('INVALID_TIMEOUT');
    const fingerprint = hash({ command, durationMs });
    const already = byOwnerKey.get(identity.scopeKey, idempotencyKey);
    if (already) {
      if (already.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
      return view(already);
    }
    if (pending.length + active >= maxQueued) throw Error('EXECUTOR_QUEUE_FULL');
    // Never silently purge an idempotency record: that could replay a
    // previously completed write on retry after the retention horizon.
    if (historyCount.get().count >= maxHistory) throw Error('EXECUTOR_HISTORY_LIMIT');
    const check = runner.probeSandbox();
    if (!check.available) throw Error('SANDBOX_UNAVAILABLE: ' + check.error);
    const id = randomUUID();
    insert.run(id, identity.scopeKey, command.workspaceId, idempotencyKey, fingerprint, now(), durationMs);
    pending.push({
      id, command, durationMs, scopeKey: identity.scopeKey,
      scope, tool, // private in-memory capability only; never serialized to SQLite
    });
    onAudit({ event: 'execution_queued', jobId: id,
      workspaceId: command.workspaceId, principal: identity.subject });
    queueMicrotask(pump);
    return view(byId.get(id));
  }
  function owned(scope, tool, id) {
    const row = byId.get(id);
    if (!row) throw Error('JOB_NOT_FOUND');
    authority.sameOwner(scope, row.owner_key, tool, row.workspace_id);
    return row;
  }
  function getJob(scope, id) {
    return view(owned(scope, 'get_job', id));
  }
  function listJobs(scope, workspaceId, limit = 30) {
    const identity = authority.requireGrant(scope, 'list_jobs', workspaceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('INVALID_LIMIT');
    return listByOwner.all(identity.scopeKey, limit)
      .filter(row => row.workspace_id === workspaceId).map(view);
  }
  function cancelJob(scope, id) {
    const row = owned(scope, 'cancel_job', id);
    if (FINAL.has(row.state)) return view(row);
    if (row.state === 'queued') {
      writeOutcome(id, { status: 'cancelled', exitCode: null });
      return view(byId.get(id));
    }
    running.get(id)?.terminate('cancelled', 'SIGTERM');
    return view(byId.get(id));
  }
  async function waitJobs(scope, ids, maxWaitMs = 1_000) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 12 ||
        !Number.isInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 1_500)
      throw Error('INVALID_WAIT');
    const deadline = Date.now() + maxWaitMs;
    let result;
    while (true) {
      result = ids.map(id => view(owned(scope, 'wait_jobs', id)));
      if (result.every(row => FINAL.has(row.state)) || Date.now() >= deadline) return result;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }
  async function runCommand(scope, command, durationMs = runner.maxDurationMs) {
    const row = enqueue(scope, 'run_command', command, {
      idempotencyKey: 'command-' + randomUUID(), durationMs,
    });
    while (true) {
      const current = byId.get(row.jobId);
      if (FINAL.has(current.state)) return view(current);
      await sleep(35);
    }
  }
  function spawnJob(scope, command, options) { return enqueue(scope, 'spawn_job', command, options); }
  async function runParallel(scope, commands, { idempotencyKey, durationMs } = {}) {
    if (closed) throw Error('EXECUTOR_CLOSED');
    if (!Array.isArray(commands) || commands.length < 1 ||
        commands.length > Math.min(runner.maxConcurrent * 4, 16) ||
        !KEY.test(idempotencyKey ?? '')) throw Error('INVALID_PARALLEL');
    const duration = durationMs ?? runner.maxDurationMs;
    if (!Number.isInteger(duration) || duration < 200 || duration > runner.maxDurationMs)
      throw Error('INVALID_TIMEOUT');

    // Validate every identity, input, idempotency collision, queue slot, and
    // immutable-history slot BEFORE inserting even one batch member.
    const plans = commands.map((input, index) => {
      const command = validateCommand(input);
      const identity = authority.requireGrant(scope, 'run_parallel',
        command.workspaceId, command.write);
      const key = idempotencyKey + ':' + index;
      if (!KEY.test(key)) throw Error('INVALID_PARALLEL');
      const fingerprint = hash({ command, durationMs: duration });
      const prior = byOwnerKey.get(identity.scopeKey, key);
      if (prior && prior.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
      return { command, identity, key, fingerprint, prior,
        id: prior?.id ?? randomUUID() };
    });
    const fresh = plans.filter(plan => !plan.prior);
    if (pending.filter(task => byId.get(task.id)?.state === 'queued').length +
        active + fresh.length > maxQueued) throw Error('EXECUTOR_QUEUE_FULL');
    if (historyCount.get().count + fresh.length > maxHistory)
      throw Error('EXECUTOR_HISTORY_LIMIT');
    if (fresh.length) {
      const check = runner.probeSandbox();
      if (!check.available) throw Error('SANDBOX_UNAVAILABLE: ' + check.error);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const plan of fresh) {
          insert.run(plan.id, plan.identity.scopeKey, plan.command.workspaceId,
            plan.key, plan.fingerprint, now(), duration);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      // Only schedule after *all* inserts committed. A partial SQLite
      // failure can never execute work with an unreturned job ID.
      for (const plan of fresh) {
        pending.push({
          id: plan.id, command: plan.command, durationMs: duration,
          scopeKey: plan.identity.scopeKey, scope, tool: 'run_parallel',
        });
        onAudit({ event: 'execution_queued', jobId: plan.id,
          workspaceId: plan.command.workspaceId, principal: plan.identity.subject });
      }
      queueMicrotask(pump);
    }
    while (true) {
      const rows = plans.map(plan => view(byId.get(plan.id)));
      if (rows.every(row => FINAL.has(row.state))) return rows;
      await sleep(40);
    }
  }
  function cancelScope(scope) {
    // Privilege revocation terminates active work and makes queued operations
    // terminal before any process launch, even if the caller cannot getJob.
    for (const task of pending) {
      if (task.scope === scope) writeOutcome(task.id, {
        status: 'cancelled', errorCode: 'AUTHORIZATION_REVOKED',
      });
    }
    for (const [id, ownerScope] of runningScopes) {
      if (ownerScope === scope) running.get(id)?.terminate('cancelled', 'SIGTERM');
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    for (const task of pending) writeOutcome(task.id, { status: 'interrupted',
      errorCode: 'EXECUTOR_STOPPED' });
    pending.length = 0;
    for (const handle of running.values()) handle.terminate('interrupted');
    await Promise.all([...running.values()].map(handle => handle.completion));
    db.close();
    closeSync(lease);
    unlinkSync(leaseFile);
  }
  return Object.freeze({
    spawnJob, getJob, listJobs, cancelJob, waitJobs, runCommand, runParallel, cancelScope, close,
    get runningCount() { return active; },
  });
}
