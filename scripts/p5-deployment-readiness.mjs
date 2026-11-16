#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ABR-28 P5.3 pre-deployment source contract audit.
 * Read-only and offline: never connects to systemd, Linear, Cloudflare or SSH;
 * never reads live .env, secrets or the on-disk job ledger.
 */
export async function auditBridgeDeployment({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  readFile = file => fs.readFile(file, "utf8"),
} = {}) {
  const checks = [];
  async function check(id, relativeFile, predicate) {
    let passed = false;
    let reason = "contract mismatch";
    try {
      const source = await readFile(path.join(root, relativeFile));
      passed = predicate(source);
      reason = passed ? "verified" : "contract mismatch";
    } catch (error) {
      reason = error?.code === "ENOENT" ? "source file missing" : "source read failed";
    }
    checks.push({ id, passed: Boolean(passed), reason });
  }
  await check("loader-target", "linear-agent-bridge/agent-bridge.mjs",
    source => /^\s*(?:\/\/[^\n]*\n)?import "\.\.\/bridge\/server\/agent-bridge-runtime\.mjs";\s*$/.test(source));
  await check("runtime-root", "bridge/server/agent-bridge-runtime.mjs",
    source => source.includes('new URL("../../linear-agent-bridge/agent-bridge.mjs", import.meta.url)') &&
      source.includes('const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs")') &&
      source.includes('const server = http.createServer(async (request, response) => {') &&
      source.includes("server.listen(PORT, HOST,"));
  await check("systemd-loader", "scripts/linux/install-systemd.sh",
    source => source.includes("User=${USER_NAME}") &&
      source.includes('ExecStart=/usr/bin/bash ${SCRIPT_Q} bridge') &&
      source.includes('WorkingDirectory=${ROOT_Q}') &&
      source.includes("NODE_ENV=production") &&
      source.includes('Installed ${UNIT}; NOT restarted or enabled.'));
  await check("env-wrapper", "scripts/with-env.sh",
    source => source.includes('require BRIDGE_SHARED_SECRET') &&
      source.includes('exec node "${REPO_ROOT}/linear-agent-bridge/agent-bridge.mjs"')));
  await check("mac-loader", "linear-agent-bridge/start-bridge.sh",
    source => source.includes('exec "${NODE_BIN}" "${ROOT}/linear-agent-bridge/agent-bridge.mjs"')));
  await check("loopback-probe", "scripts/p5-bridge-smoke.mjs",
    source => source.includes('http://127.0.0.1:') &&
      source.includes('request("/health"') &&
      source.includes('request("/diagnostics/probe"') &&
      !source.includes('request("/jobs"')));
  await check("ssh-ack", "routing/ssh/ssh-dispatch.mjs",
    source => source.includes('REMOTE_ACCEPTED:') &&
      source.includes('StrictHostKeyChecking=yes') &&
      source.includes('awaiting_external') &&
      source.includes('remoteCompletionConfirmedAt')));
  await check("mac-callback-capability", "bridge/orchestration/remote-execution-coordinator.mjs",
    source => source.includes("remoteActivityTokenHash: hashRemoteToken(remoteActivityToken)") &&
      source.includes('await dispatch({ job: message, jobKey, jobStore })') &&
      source.includes("validateTraeCompletionUrl(")));
  await check("durable-ledger", "jobs/persistence/job-store.mjs",
    source => source.includes("export function createJobStore(") &&
      source.includes("async reconcile(")));
  await check("diagnostic-auth", "bridge/handlers/diagnostic-routes.mjs",
    source => source.includes('request.headers.authorization !== `Bearer ${sharedSecret}`') &&
      source.includes('url.pathname === "/diagnostics/probe"')));
  const passed = checks.every(item => item.passed);
  return { ok: passed, checkCount: checks.length, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditBridgeDeployment().then(result => {
    for (const item of result.checks) {
      console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.reason}`);
    }
    console.log(`P5.3 source readiness: ${result.ok ? "PASS" : "FAIL"} (${result.checks.filter(x => x.passed).length}/${result.checkCount})`);
    if (!result.ok) process.exitCode = 1;
  }).catch(() => {
    console.error("P5.3 source readiness failed: unexpected audit error");
    process.exitCode = 1;
  });
}
