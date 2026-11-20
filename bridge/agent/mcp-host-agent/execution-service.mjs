// ABR-96 entrypoint for a separately authorized *local* Ubuntu host.
// This is not imported by the ABR-94 relay or the production Bridge runtime.
// ABR-97/98 will provide an authenticated, device-scoped MCP adapter; this
// module will not accept principals or authority asserted by tool arguments.
import { createSandboxRunner } from './sandbox-runner.mjs';
import { createExecutionAuthority } from './execution-authority.mjs';
import { createExecutionJobs } from './async-jobs.mjs';
import { createTerminalSessions } from './terminal-sessions.mjs';

export function createUbuntuExecutionService({
  deviceId, grants, projectsRoot, workspaces, journalDir,
  expectedUid, secrets = [], maxDurationMs, maxConcurrent, maxQueued,
  maxHistory,
  allowRootForIsolatedTests = false, capabilityTtlMs,
  onAudit,
}) {
  const authority = createExecutionAuthority({
    deviceId, grants, ttlMs: capabilityTtlMs,
  });
  const runner = createSandboxRunner({
    projectsRoot, workspaces, expectedUid, secrets, maxDurationMs, maxConcurrent,
    allowRootForIsolatedTests,
  });
  const jobs = createExecutionJobs({
    runner, authority, journalDir, maxQueued, maxHistory, onAudit,
  });
  const terminals = createTerminalSessions({ runner, authority });
  return Object.freeze({
    issueFromVerifiedIdentity: authority.issueFromVerifiedIdentity,
    revokeScope: authority.revoke,
    probeSandbox: runner.probeSandbox,
    runCommand: jobs.runCommand,
    spawnJob: jobs.spawnJob,
    waitJobs: jobs.waitJobs,
    getJob: jobs.getJob,
    listJobs: jobs.listJobs,
    cancelJob: jobs.cancelJob,
    runParallel: jobs.runParallel,
    startProcess: terminals.startProcess,
    readProcessOutput: terminals.readProcessOutput,
    interactWithProcess: terminals.interactWithProcess,
    forceTerminate: terminals.forceTerminate,
    killProcess: terminals.killProcess,
    listSessions: terminals.listSessions,
    listProcesses: terminals.listProcesses,
    async close() {
      await Promise.all([terminals.close(), jobs.close()]);
    },
  });
}
