import { spawn } from "node:child_process";
import { validateSshSettings } from "./host-routing.mjs";

const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function buildSshArgs(env = process.env) {
  const { host, nodeBin, runner } = validateSshSettings(env);
  const command = shellQuote(nodeBin) + " " + shellQuote(runner);
  return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes", host, command];
}

// An SSH process starting is not proof that the remote agent started.
// Only the remote runner's explicit ACK is accepted as delivery.
export function launchMacTrae({ job, jobKey, jobStore, env = process.env, spawnImpl = spawn, log = console }) {
  const args = buildSshArgs(env);
  const child = spawnImpl("ssh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let accepted = false;
  let output = "";
  let finished = false;
  let settle;
  let fail;
  const acknowledged = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const timer = setTimeout(() => {
    if (!accepted) {
      child.kill("SIGTERM");
      fail(Error("Mac runner did not acknowledge the job within 20 seconds"));
    }
  }, 20000);
  child.stdout.on("data", chunk => {
    const text = chunk.toString("utf8");
    output += text;
    if (output.length > 100000) output = output.slice(-5000);
    if (!accepted && output.includes("REMOTE_ACCEPTED:" + job.jobId)) {
      accepted = true;
      clearTimeout(timer);
      void jobStore.transition(jobKey, "running", { executionHost: "macos", remoteAcceptedAt: new Date().toISOString() })
        .then(settle, fail);
    }
    log.log("[Mac Trae] " + text.trimEnd());
  });
  child.stderr.on("data", chunk => log.error("[Mac Trae] " + chunk.toString("utf8").trimEnd()));
  child.on("error", error => {
    clearTimeout(timer);
    if (!accepted) fail(error);
    void jobStore.transition(jobKey, "failed", { error: error.message }).catch(log.error);
  });
  child.on("close", (code, signal) => {
    finished = true;
    clearTimeout(timer);
    if (!accepted) {
      fail(Error("Mac SSH runner exited without acceptance (code " + code + ")"));
      return;
    }
    void jobStore.transition(jobKey, code === 0 ? "completed" : "failed", {
      exitCode: code, signal, executionHost: "macos",
      ...(code !== 0 ? { error: "Remote runner exit code " + code } : {}),
    }).catch(log.error);
  });
  // Single JSON request over the encrypted SSH channel; no shell interpolation of job text.
  child.stdin.end(JSON.stringify(job));
  return acknowledged;
}
