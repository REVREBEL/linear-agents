// ABR-96 readiness probe. No listener, host tool, filesystem writes or
// persistent process. Run as the service's ACTUAL OS identity before rollout.
import { probeSandbox } from '../bridge/agent/mcp-host-agent/sandbox-runner.mjs';

const strict = process.argv.includes('--strict');
const probe = probeSandbox();
const result = {
  type: 'revrebel.mcp.ubuntu_sandbox_probe',
  uid: probe.uid,
  available: probe.available,
  error: probe.error,
  expectedServiceUser: 'bridge',
  status: probe.available ? 'READY_FOR_FURTHER_TESTS' : 'BLOCKED_BY_OS_NAMESPACE_POLICY',
};
process.stdout.write(JSON.stringify(result) + '\n');
if (strict && !probe.available) process.exitCode = 2;
