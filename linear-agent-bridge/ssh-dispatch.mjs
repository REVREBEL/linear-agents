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
export function launchMacTrae({ job, jobKey, jobStore, onExit, env = process.env, spawnImpl = spawn, log = console }) {
  const args = buildSshArgs(env);
  const child = spawnImpl("ssh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let accepted = false;
  let output = "";
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
    clearTimeout(timer);
    if (!accepted) {
      fail(Error("Mac SSH runner exited without acceptance (code " + code + ")"));
      return;
    }
    // A process exit is not, by itself, a verified Linear completion.
    // Notify Linear through the central bridge, then update the durable ledger.
    void (async () => {
      const confirmed = code === 0 && onExit ? await onExit(code, signal) : false;
      const state = code !== 0 ? "failed" : confirmed ? "completed" : "awaiting_external";
      await jobStore.transition(jobKey, state, {
        exitCode: code, signal, executionHost: "macos",
        ...(code !== 0 ? { error: "Remote runner exit code " + code } : {}),
        ...(code === 0 && !confirmed ? { note: "Mac runner exited but Linear completion was not confirmed" } : {}),
      });
    })().catch(error => log.error("Unable to confirm Mac execution completion:", error));
  });
  // Single JSON request over the encrypted SSH channel; no shell interpolation of job text.
  child.stdin.on("error", error => {
    // Handle EPIPE if SSH exits before reading the full job payload.
    if (!accepted) {
      clearTimeout(timer);
      fail(error);
    }
    void jobStore.transition(jobKey, "failed", {
      error: "SSH stdin transport: " + error.message, executionHost: "macos",
    }).catch(log.error);
  });
  child.stdin.end(JSON.stringify(job));
  return acknowledged;
}

export function cleanupMacTrae({ job, env = process.env, spawnImpl = spawn }) {
  const args = buildSshArgs(env);
  return new Promise((resolve, reject) => {
    const child = spawnImpl("ssh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(true);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(Error("Remote cleanup timed out"));
    }, 20000);
    child.stdin.on("error", done);
    child.on("error", done);
    child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.length > 10000) stdout = stdout.slice(-1000); });
    child.stderr.on("data", chunk => { stderr += String(chunk); if (stderr.length > 10000) stderr = stderr.slice(-1000); });
    child.on("close", code => {
      if (code === 0 && stdout.includes("REMOTE_CLEANED:" + job.jobId)) done();
      else done(Error("Remote cleanup not confirmed (SSH exit " + code + "): " + stderr.slice(-300)));
    });
    child.stdin.end(JSON.stringify(job));
  });
}
