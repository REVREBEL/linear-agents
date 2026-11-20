// ABR-96 isolated rootless OS sandbox + owner-scoped async execution tests.
// Real target UID must pass the same test before any service activation.
// CI may lack Ubuntu AppArmor userns permission; it must report runtime SKIPs,
// not silently disable the bubblewrap boundary or execute outside the sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createExecutionJobs } from '../bridge/agent/mcp-host-agent/async-jobs.mjs';
import { createExecutionAuthority } from '../bridge/agent/mcp-host-agent/execution-authority.mjs';
import { createUbuntuExecutionService } from '../bridge/agent/mcp-host-agent/execution-service.mjs';
import { createSandboxRunner, probeSandbox } from '../bridge/agent/mcp-host-agent/sandbox-runner.mjs';

const deviceId = 'ubuntu-test';
const fullTools = [
  'run_command', 'spawn_job', 'get_job', 'list_jobs', 'wait_jobs', 'cancel_job',
  'run_parallel', 'start_process', 'read_process_output', 'interact_with_process',
  'force_terminate', 'kill_process', 'list_sessions', 'list_processes',
];
const grants = {
  'dev-a@example.invalid': {
    clients: ['client-a'], sessions: ['session-a', 'session-a-recovery'],
    devices: [deviceId], workspaces: ['project-a'],
    tools: fullTools, write: true,
  },
  'dev-b@example.invalid': {
    clients: ['client-b'], sessions: ['session-b'],
    devices: [deviceId], workspaces: ['project-a'],
    tools: fullTools, write: false,
  },
};
const grantA = {
  subject: 'dev-a@example.invalid', clientId: 'client-a', sessionId: 'session-a',
  authenticatedDeviceId: deviceId,
};
const grantB = {
  subject: 'dev-b@example.invalid', clientId: 'client-b', sessionId: 'session-b',
  authenticatedDeviceId: deviceId,
};
const py = (code, extra = {}) => ({
  workspaceId: 'project-a', program: 'python3',
  args: ['-c', code], ...extra,
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = async (fn, deadline = 3_000) => {
  const end = Date.now() + deadline;
  let result;
  while (Date.now() < end) {
    result = await fn();
    if (['completed','failed','cancelled','timed_out','interrupted'].includes(result?.state)) return result;
    await delay(30);
  }
  throw Error('TIMED_OUT_WAITING_FOR_JOB');
};
async function writableTempParent() {
  try { await access(tmpdir(), constants.W_OK); return tmpdir(); }
  catch { return '/var/tmp'; }
}
async function setup(t) {
  // The actual Ubuntu host currently mounts /tmp as root-owned mode 0755;
  // /var/tmp (1777) is the writable disposable fixture location for bridge.
  const root = await mkdtemp(path.join(await writableTempParent(), 'abr96-exec-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'project-a');
  const other = path.join(root, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(other);
  await writeFile(path.join(project, 'allowed.txt'), 'ALLOWED_IN_SANDBOX');
  await writeFile(path.join(other, 'secret.txt'), 'SECRET_OUTSIDE_SANDBOX');
  await symlink(path.join(other, 'secret.txt'), path.join(project, 'escape'));
  const config = {
    deviceId, grants, projectsRoot: projects, workspaces: { 'project-a': project },
    journalDir: path.join(root, 'journal'), expectedUid: process.getuid(),
    allowRootForIsolatedTests: true, secrets: ['CHECKPOINT_SECRET_123456'],
    maxDurationMs: 3_000, maxConcurrent: 1, maxQueued: 8,
  };
  return { root, projects, project, other, config };
}

test('ABR-96 server-owned execution capability denies unverified/cross-scope claims', async t => {
  const authority = createExecutionAuthority({ deviceId, grants });
  assert.throws(() => authority.issueFromVerifiedIdentity({
    ...grantA, authenticatedDeviceId: 'other-device',
  }), /EXECUTION_NOT_AUTHORIZED/);
  assert.throws(() => authority.issueFromVerifiedIdentity({
    ...grantA, clientId: 'client-b',
  }), /EXECUTION_NOT_AUTHORIZED/);
  assert.throws(() => authority.issueFromVerifiedIdentity({
    ...grantA, sessionId: 'session-b',
  }), /EXECUTION_NOT_AUTHORIZED/);
  assert.throws(() => authority.issueFromVerifiedIdentity({
    ...grantA, subject: 'forged@example.invalid',
  }), /EXECUTION_NOT_AUTHORIZED/);
  const a = authority.issueFromVerifiedIdentity(grantA);
  const b = authority.issueFromVerifiedIdentity(grantB);
  assert.equal(authority.requireGrant(a, 'run_command', 'project-a', true).subject,
    'dev-a@example.invalid');
  assert.throws(() => authority.requireGrant(b, 'run_command', 'project-a', true),
    /EXECUTION_NOT_AUTHORIZED/);
  assert.throws(() => authority.requireGrant(a, 'submit_work', 'project-a'),
    /EXECUTION_NOT_AUTHORIZED/);
  assert.throws(() => authority.requireGrant({}, 'run_command', 'project-a'),
    /EXECUTION_NOT_AUTHORIZED/);
  assert.throws(() => authority.requireGrant(a, 'run_command', 'other-project'),
    /EXECUTION_NOT_AUTHORIZED/);
  assert.equal(authority.revoke(a), true);
  assert.throws(() => authority.requireGrant(a, 'run_command', 'project-a'),
    /EXECUTION_NOT_AUTHORIZED/);
  let clock = 100_000;
  const expiring = createExecutionAuthority({
    deviceId, grants, ttlMs: 1_000, now: () => clock,
  });
  const temporary = expiring.issueFromVerifiedIdentity(grantA);
  assert.equal(expiring.requireGrant(temporary, 'run_command', 'project-a').subject,
    'dev-a@example.invalid');
  clock += 1_001;
  assert.throws(() => expiring.requireGrant(temporary, 'run_command', 'project-a'),
    /EXECUTION_NOT_AUTHORIZED/);
});

test('ABR-96 executor refuses unexpected UID, root service identity and escaped project roots', async t => {
  const { config, root, other } = await setup(t);
  t.after(async () => rm(root, { recursive: true, force: true }));
  assert.throws(() => createSandboxRunner({
    ...config, expectedUid: process.getuid() + 1,
  }), /UNEXPECTED_OS_PRINCIPAL/);
  if (process.getuid() === 0) {
    assert.throws(() => createSandboxRunner({ ...config, allowRootForIsolatedTests: false }),
      /ROOT_PRINCIPAL_DENIED/);
  }
  assert.throws(() => createSandboxRunner({
    ...config, workspaces: { 'project-a': other },
  }), /WORKSPACE_OUTSIDE_PROJECTS_ROOT/);
  const probe = probeSandbox();
  assert.equal(typeof probe.available, 'boolean');
  if (!probe.available) assert.match(probe.error, /sandbox|namespace|Permission|file|ENOENT/i);
});

test('ABR-96 sandboxed execution and durable jobs (Linux namespace evidence)', async t => {
  const { root, project, config } = await setup(t);
  const probe = probeSandbox();
  if (!probe.available) {
    t.diagnostic('BLOCKED: actual runtime sandbox unavailable for UID ' + probe.uid + ': ' + probe.error);
    if (process.env.ABR96_REQUIRE_SANDBOX === '1')
      throw Error('REQUIRED_SANDBOX_UNAVAILABLE: ' + probe.error);
    return t.skip('Rootless Bubblewrap not permitted; no unsandboxed fallback');
  }
  let service = createUbuntuExecutionService(config);
  let scopeA = service.issueFromVerifiedIdentity(grantA);
  let scopeB = service.issueFromVerifiedIdentity(grantB);
  t.after(async () => {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  });
  await t.test('stdout/stderr, real exit code, no host filesystem, stdin closes', async () => {
    const result = await service.runCommand(scopeA, py(
      'import sys,os,pathlib; print(pathlib.Path("allowed.txt").read_text());print(pathlib.Path("/home").exists());print(os.getenv("HOST_SENTINEL", "ABSENT"));print(sys.stdin.read()=="");print("ERR",file=sys.stderr);sys.exit(7)',
    ));
    assert.equal(result.state, 'failed');
    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /ALLOWED_IN_SANDBOX\nFalse\nABSENT\nTrue/);
    assert.match(result.stderr, /ERR/);
    assert.equal(await readFile(path.join(project, 'allowed.txt'), 'utf8'), 'ALLOWED_IN_SANDBOX');
  });
  await t.test('no network and no reachable host secrets or out-of-workspace symlinks', async () => {
    const result = await service.runCommand(scopeA, py(
      'from pathlib import Path;import socket;print(Path("/etc/shadow").exists());print(Path("escape").exists());s=socket.socket();\ntry:s.connect(("127.0.0.1",9999))\nexcept OSError as e:print("NETWORK_ISOLATED")\nelse:print("BAD_NETWORK")',
    ));
    assert.equal(result.state, 'completed');
    assert.match(result.stdout, /False\nFalse\nNETWORK_ISOLATED/);
    assert.doesNotMatch(result.stdout, /BAD_NETWORK/);
  });
  await t.test('workspace is read-only unless trusted owner holds explicit write grant', async () => {
    await assert.rejects(service.runCommand(scopeB, py(
      'open("blocked.txt","w").write("bad")', { write: true },
    )), /EXECUTION_NOT_AUTHORIZED/);
    const denied = await service.runCommand(scopeB, py(
      'from pathlib import Path\ntry:Path("readonly.txt").write_text("bad")\nexcept OSError:print("READ_ONLY")',
    ));
    assert.equal(denied.state, 'completed');
    assert.match(denied.stdout, /READ_ONLY/);
    const approved = await service.runCommand(scopeA, py(
      'from pathlib import Path;Path("approved.txt").write_text("WORKSPACE_WRITE")',
      { write: true },
    ));
    assert.equal(approved.state, 'completed');
    assert.equal(await readFile(path.join(project, 'approved.txt'), 'utf8'), 'WORKSPACE_WRITE');
  });
  await t.test('known secret fixture and common bearer patterns are redacted before persistence', async () => {
    const output = await service.runCommand(scopeA, py(
      'print("CHECKPOINT_SECRET_123456");print("Bearer this-is-a-local-test-only-token");print("OPENROUTER_API_KEY=sentinel-value")',
    ));
    assert.equal(output.state, 'completed');
    assert.doesNotMatch(output.stdout, /CHECKPOINT_SECRET_123456|this-is-a-local-test-only-token|sentinel-value/);
    assert.match(output.stdout, /\[REDACTED\]/);
  });
  await t.test('stdout/stderr are bounded and truncated before SQLite persistence', async () => {
    const result = await service.runCommand(scopeA, py(
      'import sys;sys.stdout.write("A"*200000);sys.stderr.write("B"*200000)',
    ));
    assert.equal(result.state, 'completed');
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 131_072);
    assert.ok(Buffer.byteLength(result.stderr) <= 131_072);
  });
  await t.test('async job returns promptly, retries share ID, collision fails, other sessions denied', async () => {
    const command = py('import time;time.sleep(0.15);print("ONCE")');
    const start = Date.now();
    const queued = service.spawnJob(scopeA, command, { idempotencyKey: 'job-once-0001' });
    assert.ok(Date.now() - start < 250);
    assert.ok(['queued','running'].includes(queued.state));
    assert.equal(service.spawnJob(scopeA, command, { idempotencyKey: 'job-once-0001' }).jobId,
      queued.jobId);
    assert.throws(() => service.spawnJob(scopeA, py('print("DIFFERENT")'),
      { idempotencyKey: 'job-once-0001' }), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => service.getJob(scopeB, queued.jobId), /EXECUTION_NOT_AUTHORIZED/);
    assert.throws(() => service.cancelJob(scopeB, queued.jobId), /EXECUTION_NOT_AUTHORIZED/);
    await assert.rejects(service.waitJobs(scopeB, [queued.jobId]), /EXECUTION_NOT_AUTHORIZED/);
    assert.ok(service.listJobs(scopeB, 'project-a').every(j => j.jobId !== queued.jobId));
    const finished = await terminal(() => service.getJob(scopeA, queued.jobId));
    assert.equal(finished.state, 'completed');
    assert.match(finished.stdout, /ONCE/);
    assert.deepEqual((await service.waitJobs(scopeA, [queued.jobId], 200)).map(x => x.state),
      ['completed']);
  });
  await t.test('bounded concurrency, queued cancellation, running cancellation, no replay', async () => {
    const long = py('import time;time.sleep(2)');
    const first = service.spawnJob(scopeA, long, { idempotencyKey: 'job-running-1', durationMs: 2_800 });
    const second = service.spawnJob(scopeA, py('print("SHOULD_NOT_RUN")'),
      { idempotencyKey: 'job-queued-2' });
    const aborted = service.cancelJob(scopeA, second.jobId);
    assert.equal(aborted.state, 'cancelled');
    assert.doesNotMatch(aborted.stdout, /SHOULD_NOT_RUN/);
    service.cancelJob(scopeA, first.jobId);
    const ended = await terminal(() => service.getJob(scopeA, first.jobId));
    assert.equal(ended.state, 'cancelled');
    assert.equal(service.getJob(scopeA, second.jobId).state, 'cancelled');
  });
  await t.test('timeout kills child process tree; no delayed file side effect', async () => {
    const script = 'import subprocess,time,sys;subprocess.Popen([sys.executable,"-c","import time,pathlib;time.sleep(0.8);pathlib.Path(\\"late-marker\\").write_text(\\"BAD\\")"]);time.sleep(3)';
    const result = await service.runCommand(scopeA, py(script, { write: true }), 220);
    assert.equal(result.state, 'timed_out');
    await delay(950);
    await assert.rejects(stat(path.join(project, 'late-marker')), /ENOENT/);
  });
  await t.test('queued jobs favor other principals instead of starving them', async () => {
    const ordered = [];
    // The shared dispatcher uses one active slot and round-robin per owner.
    // Use audited started events in a new isolated service to observe ordering.
    await service.close();
    service = null;
    const fair = createUbuntuExecutionService({
      ...config, onAudit: record => {
        if (record.event === 'execution_started') ordered.push(record.jobId);
      },
    });
    service = fair;
    const a = fair.issueFromVerifiedIdentity(grantA);
    const b = fair.issueFromVerifiedIdentity(grantB);
    scopeA = a;
    scopeB = b;
    const jobs = [
      fair.spawnJob(a, py('import time;time.sleep(.12)'), { idempotencyKey: 'fair-a-first-1' }),
      fair.spawnJob(a, py('print("A2")'), { idempotencyKey: 'fair-a-second-2' }),
      fair.spawnJob(a, py('print("A3")'), { idempotencyKey: 'fair-a-third-3' }),
      fair.spawnJob(b, py('print("B1")'), { idempotencyKey: 'fair-b-first-4' }),
    ];
    for (let index=0; index<3; index++)
      await terminal(() => fair.getJob(a, jobs[index].jobId));
    await terminal(() => fair.getJob(b, jobs[3].jobId));
    assert.deepEqual(ordered, [
      jobs[0].jobId, jobs[3].jobId, jobs[1].jobId, jobs[2].jobId,
    ]);
  });
  await t.test('run_parallel isolates outcomes and enforces bounded fanout', async () => {
    const work = [
      py('print("PARALLEL-A")'),
      py('import sys;print("PARALLEL-B");sys.exit(4)'),
    ];
    const outcomes = await service.runParallel(scopeA, work,
      { idempotencyKey: 'parallel-batch-001' });
    assert.deepEqual(outcomes.map(x => x.state), ['completed','failed']);
    assert.deepEqual(outcomes.map(x => x.exitCode), [0,4]);
    const repeats = await service.runParallel(scopeA, work,
      { idempotencyKey: 'parallel-batch-001' });
    assert.deepEqual(repeats.map(x => x.jobId), outcomes.map(x => x.jobId));
    await assert.rejects(service.runParallel(scopeA, Array(16).fill(work[0]),
      { idempotencyKey: 'parallel-invalid-2' }), /INVALID_PARALLEL/);
  });
  await t.test('interactive Python REPL persists prompt, input, pagination and scoped kill', async () => {
    const session = service.startProcess(scopeA, {
      workspaceId: 'project-a', program: 'python3', args: ['-i','-q'],
    });
    let prompt;
    for (let i = 0; i < 25; i++) {
      prompt = service.readProcessOutput(scopeA, session.processId, 0, 10);
      if (prompt.status === 'waiting_input') break;
      await delay(35);
    }
    assert.equal(prompt.status, 'waiting_input');
    assert.ok(service.listSessions(scopeA, 'project-a')
      .some(x => x.processId === session.processId));
    assert.throws(() => service.readProcessOutput(scopeB, session.processId),
      /EXECUTION_NOT_AUTHORIZED/);
    const interaction = await service.interactWithProcess(scopeA, session.processId,
      'print("REPL_OK",2+2)\n', { waitMs: 160 });
    assert.match(interaction.output, /REPL_OK 4/);
    assert.ok(interaction.nextOffset >= 1);
    const killed = service.forceTerminate(scopeA, session.processId);
    assert.equal(killed.terminated, true);
    for (let i=0; i<30; i++) {
      if (['cancelled','completed','failed'].includes(
        service.readProcessOutput(scopeA, session.processId).status)) break;
      await delay(25);
    }
    assert.equal(service.readProcessOutput(scopeA, session.processId).status, 'cancelled');
  });
  await t.test('restart preserves completed outcome and does not replay interrupted records', async () => {
    const complete = service.spawnJob(scopeA, py('print("RESTART_FINISHED")'),
      { idempotencyKey: 'job-restart-persist' });
    await terminal(() => service.getJob(scopeA, complete.jobId));
    await service.close();
    service = null;
    const db = new DatabaseSync(path.join(root, 'journal/outcomes.sqlite'));
    const existing = db.prepare('SELECT * FROM executions WHERE id=?').get(complete.jobId);
    assert.equal(existing.state,'completed');
    db.prepare("UPDATE executions SET state='running' WHERE id=?").run(complete.jobId);
    db.close();
    service = createUbuntuExecutionService(config);
    const recovered = service.issueFromVerifiedIdentity(grantA);
    const persisted = service.getJob(recovered, complete.jobId);
    assert.equal(persisted.state, 'interrupted');
    assert.equal(persisted.errorCode, 'HOST_RESTART');
    const collision = service.spawnJob(recovered, py('print("RESTART_FINISHED")'),
      { idempotencyKey: 'job-restart-persist' });
    assert.equal(collision.jobId, complete.jobId);
    assert.equal(collision.state, 'interrupted');
  });
});

test('ABR-96 journal permissions, exclusive lease and no-replay history capacity', async t => {
  const { root, config } = await setup(t);
  const probe = probeSandbox();
  if (!probe.available) return t.skip('Nonprivileged namespace policy unavailable');
  let service = createUbuntuExecutionService({ ...config, maxHistory: 1 });
  t.after(async () => {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  });
  const cap = service.issueFromVerifiedIdentity(grantA);
  const command = py('print("ONLY_ONCE")');
  assert.throws(() => createUbuntuExecutionService({
    ...config, maxHistory: 1,
  }), /EXECUTOR_ALREADY_RUNNING/);
  const one = service.spawnJob(cap, command, { idempotencyKey: 'history-single-001' });
  const completed = await terminal(() => service.getJob(cap, one.jobId));
  assert.equal(completed.state, 'completed');
  assert.equal((await stat(path.join(root, 'journal/outcomes.sqlite'))).mode & 0o777, 0o600);
  assert.equal(service.spawnJob(cap, command, {
    idempotencyKey: 'history-single-001',
  }).jobId, one.jobId);
  assert.throws(() => service.spawnJob(cap, py('print("NO_SECOND")'), {
    idempotencyKey: 'history-overflow-002',
  }), /EXECUTOR_HISTORY_LIMIT/);
  assert.equal(service.listJobs(cap, 'project-a').length, 1);
});

test('queued jobs revalidate revoked and expired capabilities before launch', async () => {
  const root = await mkdtemp(path.join(await writableTempParent(), 'abr96-reauth-'));
  let clock = 100_000, release;
  const launched = [];
  const authority = createExecutionAuthority({ deviceId, grants, ttlMs: 1_000, now: () => clock });
  const first = authority.issueFromVerifiedIdentity(grantA);
  const revoked = authority.issueFromVerifiedIdentity(grantA);
  const expired = authority.issueFromVerifiedIdentity(grantA);
  const runner = {
    maxConcurrent: 1, maxDurationMs: 3_000, sanitize: value => String(value),
    probeSandbox: () => ({ available: true }),
    spawnCommand(command) {
      launched.push(command.args[1]);
      return { completion: new Promise(resolve => { release = resolve; }), terminate() {} };
    },
  };
  const jobs = createExecutionJobs({ runner, authority, journalDir: path.join(root, 'journal') });
  try {
    jobs.spawnJob(first, py('first'), { idempotencyKey: 'first-job-key' });
    await delay(0);
    const a = jobs.spawnJob(revoked, py('revoked', { write: true }), { idempotencyKey: 'revoked-job-key' });
    const b = jobs.spawnJob(expired, py('expired', { write: true }), { idempotencyKey: 'expired-job-key' });
    authority.revoke(revoked);
    clock += 1_001;
    const inspector = authority.issueFromVerifiedIdentity(grantA);
    release({ status: 'completed', exitCode: 0, stdout: '', stderr: '' });
    const outcomes = await jobs.waitJobs(inspector, [a.jobId, b.jobId], 1_000);
    assert.deepEqual(launched, ['first']);
    assert.ok(outcomes.every(row => row.state === 'failed' && row.errorCode === 'EXECUTION_NOT_AUTHORIZED'));
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ABR-96 revoked queued write never launches; in-flight process is terminated', async t => {
  const { root, project, config } = await setup(t);
  if (!probeSandbox().available) return t.skip('Bubblewrap namespace unavailable');
  const service = createUbuntuExecutionService(config);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const scope = service.issueFromVerifiedIdentity(grantA);
  const observer = service.issueFromVerifiedIdentity(grantA);
  const long = service.spawnJob(scope, py(
    'import time;from pathlib import Path;time.sleep(1);Path("late-from-revoked").write_text("BAD")',
    { write: true },
  ), { idempotencyKey: 'revoke-long-run-01' });
  const queued = service.spawnJob(scope, py(
    'from pathlib import Path;Path("queued-from-revoked").write_text("BAD")',
    { write: true },
  ), { idempotencyKey: 'revoke-queued-002' });
  // Ensure process entered running state before revocation is applied.
  for (let i = 0; i < 25 && service.getJob(scope, long.jobId).state === 'queued'; i++) {
    await delay(10);
  }
  assert.equal(service.revokeScope(scope), true);
  assert.throws(() => service.getJob(scope, long.jobId), /EXECUTION_NOT_AUTHORIZED/);
  const first = await terminal(() => service.getJob(observer, long.jobId));
  const second = await terminal(() => service.getJob(observer, queued.jobId));
  assert.equal(first.state, 'cancelled');
  assert.equal(second.state, 'cancelled');
  assert.equal(second.errorCode, 'AUTHORIZATION_REVOKED');
  await delay(1_100);
  await assert.rejects(stat(path.join(project, 'late-from-revoked')), /ENOENT/);
  await assert.rejects(stat(path.join(project, 'queued-from-revoked')), /ENOENT/);
});

test('ABR-96 expired queued write is revalidated immediately before scheduling', async t => {
  const { root, project, config } = await setup(t);
  if (!probeSandbox().available) return t.skip('Bubblewrap namespace unavailable');
  const service = createUbuntuExecutionService({ ...config, capabilityTtlMs: 1_000 });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const scope = service.issueFromVerifiedIdentity(grantA);
  const blocking = service.spawnJob(scope, py('import time;time.sleep(1.3)'),
    { idempotencyKey: 'expire-blocker-001', durationMs: 2_800 });
  const forbidden = service.spawnJob(scope, py(
    'from pathlib import Path;Path("expired-write").write_text("BAD")',
    { write: true },
  ), { idempotencyKey: 'expire-write-002' });
  await delay(1_500);
  const renewed = service.issueFromVerifiedIdentity(grantA);
  assert.equal(service.getJob(renewed, blocking.jobId).state, 'completed');
  const outcome = service.getJob(renewed, forbidden.jobId);
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.errorCode, 'EXECUTION_NOT_AUTHORIZED');
  await assert.rejects(stat(path.join(project, 'expired-write')), /ENOENT/);
});
