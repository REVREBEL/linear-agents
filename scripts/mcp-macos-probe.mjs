// ABR-97 operator-run, strictly read-only Mac launchd identity probe.
// Uses the existing trusted SSH alias. No keys, passwords, enrollment,
// remote file writes, launchd changes or automatic host activation.
import { probeMacOverTrustedSsh } from '../bridge/agent/mcp-host-agent/macos-host-probe.mjs';

try {
  const host = await probeMacOverTrustedSsh({
    sshAlias: process.env.MAC_SSH_HOST || 'macos',
    expectedPrincipal: process.env.MAC_EXPECTED_PRINCIPAL || undefined,
    expectedRoot: process.env.OSX_PROJECTS_ROOT || undefined,
  });
  process.stdout.write(JSON.stringify({
    probe: 'ABR-97-macos-identity',
    status: 'IDENTITY_CONFIRMED',
    ...host,
  }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({
    probe: 'ABR-97-macos-identity',
    status: 'NOT_VERIFIED',
    reason: error.message,
  }) + '\n');
  process.exitCode = 2;
}
