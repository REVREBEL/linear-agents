// ABR-98 — read-only structured Git operations under the ABR-96 sandbox.
// No host shell, external diff, mutable repository hooks, network or global
// Git config. Tool grants are verified independently per invocation.
import { createHash } from 'node:crypto';

const PATHSPEC = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./@+-]{1,512}$/;
const LIMIT = 128 * 1024;
const GLOBAL = [
  '--no-optional-locks', '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat',
  '-c', 'diff.external=', '-c', 'diff.trustExitCode=false',
];
export function createReadOnlyGitTools({ runner, authority }) {
  if (typeof runner?.spawnCommand !== 'function' ||
      typeof authority?.requireGrant !== 'function')
    throw TypeError('TRUSTED_SANDBOX_AND_AUTHORITY_REQUIRED');
  async function execute(scope, name, { workspaceId, pathspec, staged = false, limit = 10 } = {}) {
    if (!['git_status','git_diff','git_log'].includes(name) ||
        typeof workspaceId !== 'string' ||
        pathspec !== undefined && !PATHSPEC.test(pathspec) ||
        typeof staged !== 'boolean' || !Number.isInteger(limit) ||
        limit < 1 || limit > 50)
      throw Error('INVALID_GIT_ARGUMENTS');
    authority.requireGrant(scope, name, workspaceId, false);
    const args = [...GLOBAL];
    if (name === 'git_status') args.push('status', '--short', '--branch', '--untracked-files=no');
    if (name === 'git_diff') {
      args.push('diff', '--no-ext-diff', '--no-textconv');
      if (staged) args.push('--cached');
      args.push('--');
      if (pathspec !== undefined) args.push(pathspec);
    }
    if (name === 'git_log') args.push('log', '--no-ext-diff',
      '--no-decorate', '-n', String(limit), '--format=%H %s', '--');
    const handle = runner.spawnCommand({
      workspaceId, program: 'git', args, write: false,
    }, { durationMs: 6_000 });
    const result = await handle.completion;
    return Object.freeze({
      tool: name, workspaceId, state: result.status, exitCode: result.exitCode,
      stdout: result.stdout, stderr: result.stderr,
      truncated: result.stdoutTruncated || result.stderrTruncated,
      sha256: createHash('sha256').update(result.stdout).digest('hex'),
      source: 'sandboxed-git',
      maxStreamBytes: LIMIT,
    });
  }
  return Object.freeze({
    gitStatus: (scope, options) => execute(scope, 'git_status', options),
    gitDiff: (scope, options) => execute(scope, 'git_diff', options),
    gitLog: (scope, options) => execute(scope, 'git_log', options),
  });
}
