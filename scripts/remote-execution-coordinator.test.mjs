import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { coordinateRemoteExecution } from "../jobs/remote-execution-coordinator.mjs";

const env = {
  TRAE_WORKER_HOST: "linear-trae.example.test",
  TRAE_HOST: "trae-agent.example.test",
  MAC_TRAE_BIN: "trae",
  TRAE_GITHUB_APP_NAME: "test-trae",
  TRAE_GITHUB_APP_ID: "1234",
};

function fixture(overrides = {}) {
  const trace = [];
  const job = {
    routing: { projectId: "project-a" }, issueId: "ISSUE-1",
    source: "linear", sessionAction: "prompted",
    completionUrl: "https://linear-trae.example.test/complete",
    payload: { data: { promptContext: "Run this task" } },
  };
  const route = { scopeKey: "scope-a", repository: "REVREBEL/repo",
    projectScope: "project", launchFromScope: false, launchDirectory: "/repo" };
  const args = {
    agent: "trae", job, jobKey: "trae:webhook-id", safeJobId: "webhook-id",
    credential: { accessToken: "mock-access-token" },
    host: "trae-agent.example.test", route,
    jobStore: { transition: async (...items) => { trace.push(["transition", ...items]); } },
    osxProjectsRoot: "/mac/projects",
    extractPromptContext: j => j.payload?.data?.promptContext,
    extractDirectTask: value => value,
    extractAgentSessionId: () => "session-a",
    env,
    generateToken: () => "ab".repeat(32),
    dispatch: async options => { trace.push(["ssh", options]); },
    ...overrides,
  };
  return { trace, args, job, route };
}

test("valid Mac Trae delivery persists authorized context before awaiting SSH ACK", async () => {
  const f = fixture();
  const result = await coordinateRemoteExecution(f.args);
  assert.deepEqual(result, { status: 202, body: {
    ok: true, accepted: true, jobId: "webhook-id",
    executionHost: "macos", host: "trae-agent.example.test",
  } });
  assert.deepEqual(f.trace.map(x => x[0]), ["transition", "ssh"]);
  const [, key, state, patch] = f.trace[0];
  assert.equal(key, "trae:webhook-id");
  assert.equal(state, "launching");
  assert.equal(patch.executionHost, "macos");
  assert.equal(patch.workspace, "/repo");
  assert.equal(patch.agentSessionId, "session-a");
  assert.equal(patch.issueId, "ISSUE-1");
  assert.equal(patch.attempts, 1);
  assert.deepEqual(patch.remoteTask, {
    jobId: "webhook-id", repository: "REVREBEL/repo", projectId: "scope-a",
  });
  assert.equal(patch.remoteActivityTokenHash,
    crypto.createHash("sha256").update("ab".repeat(32)).digest("hex"));
  assert.equal(patch.remoteCompletionUrl, "https://linear-trae.example.test/complete");
  assert.equal(JSON.stringify(patch).includes("mock-access-token"), false);
  assert.equal(JSON.stringify(patch).includes("ab".repeat(32)), false);

  const options = f.trace[1][1];
  assert.equal(options.jobKey, "trae:webhook-id");
  assert.equal(options.jobStore, f.args.jobStore);
  assert.equal(options.job.projectId, "scope-a");
  assert.equal(options.job.repository, "REVREBEL/repo");
  assert.equal(options.job.projectsRoot, "/mac/projects");
  assert.equal(options.job.prompt, "Run this task");
  assert.equal(options.job.activityToken, "ab".repeat(32));
  assert.equal(options.job.accessToken, "mock-access-token");
  assert.equal(options.job.activityEndpoint, "https://trae-agent.example.test/trae-activity");
  assert.equal(options.job.completionEndpoint, "https://trae-agent.example.test/trae-complete");
  assert.equal(options.job.traeBin, "trae");
  assert.equal(options.job.githubAppName, "test-trae");
  assert.equal(options.job.githubAppId, "1234");
});

test("unsupported Mac agent records unrouted without SSH dispatch", async () => {
  const f = fixture({ agent: "gemini" });
  const result = await coordinateRemoteExecution(f.args);
  assert.deepEqual(result, { status: 422, body: {
    ok: false, accepted: false, error: "Mac SSH runner currently supports Trae only",
  } });
  assert.deepEqual(f.trace.map(x => x[0]), ["transition"]);
  assert.deepEqual(f.trace[0].slice(1), [
    "trae:webhook-id", "unrouted", { error: "Mac SSH runner currently supports Trae only" },
  ]);
});

test("missing prompt or credential fails before generating capability or dispatch", async () => {
  for (const override of [
    { credential: null },
    { extractPromptContext: () => "" },
  ]) {
    const f = fixture(override);
    const result = await coordinateRemoteExecution(f.args);
    assert.equal(result.status, 422);
    assert.equal(result.body.error, "Missing remote prompt or credential");
    assert.deepEqual(f.trace.map(x => x[0]), ["transition"]);
    assert.deepEqual(f.trace[0].slice(1), [
      "trae:webhook-id", "failed", { error: "Missing Mac Trae prompt or app credential" },
    ]);
  }
});

test("missing session or completion URL rejects before launch", async () => {
  for (const override of [
    { extractAgentSessionId: () => null },
    { job: { issueId: "ISSUE-1", payload: { data: { promptContext: "Test" } } } },
  ]) {
    const f = fixture(override);
    const result = await coordinateRemoteExecution(f.args);
    assert.equal(result.status, 422);
    assert.equal(result.body.error, "Missing Mac Trae callback context");
    assert.deepEqual(f.trace.map(x => x[0]), ["transition"]);
    assert.equal(f.trace[0][2], "failed");
  }
});

test("invalid HTTPS callback URL fails closed before publishing capability or invoking SSH", async () => {
  for (const bad of [
    "http://linear-trae.example.test/complete",
    "https://evil.example.test/complete",
    "https://linear-trae.example.test/other",
    "https://linear-trae.example.test/complete?token=x",
    "https://user:pass@linear-trae.example.test/complete",
  ]) {
    const f = fixture({ job: { issueId: "ISSUE-1",
      completionUrl: bad, payload: { data: { promptContext: "Test" } } } });
    await assert.rejects(coordinateRemoteExecution(f.args));
    assert.deepEqual(f.trace, [], bad);
  }
  const f = fixture({ env: { ...env, MAC_TRAE_ACTIVITY_URL: "https://evil.example.test/trae-activity" } });
  await assert.rejects(coordinateRemoteExecution(f.args), /expected HTTPS Trae host/);
  assert.deepEqual(f.trace, []);
});

test("failed launching ledger write prevents SSH dispatch", async () => {
  const f = fixture({
    jobStore: { transition: async () => { throw Error("durable job ledger unavailable"); } },
  });
  await assert.rejects(coordinateRemoteExecution(f.args), /durable job ledger unavailable/);
  assert.deepEqual(f.trace, []);
});

test("SSH failure transitions the ledger to failed before emitting retryable rejection", async () => {
  const f = fixture({ dispatch: async args => {
    f.trace.push(["ssh", args]);
    throw Error("SSH transport offline");
  } });
  const result = await coordinateRemoteExecution(f.args);
  assert.deepEqual(f.trace.map(x => x[0]), ["transition", "ssh", "transition"]);
  assert.deepEqual(f.trace[2].slice(1), [
    "trae:webhook-id", "failed", {
      error: "Error: SSH transport offline", executionHost: "macos",
    },
  ]);
  assert.deepEqual(result, { status: 503, body: { ok: false, accepted: false,
    error: "Mac Trae dispatch failed; reconcile remote job state before retry",
  } });
});

test("SSH acknowledgment must complete before success response", async () => {
  const f = fixture();
  let accept;
  let started = false;
  const accepted = new Promise(resolve => { accept = resolve; });
  f.args.dispatch = async () => { started = true; await accepted; };
  let finished = false;
  const pending = coordinateRemoteExecution(f.args).then(() => { finished = true; });
  for (let i = 0; i < 20 && !started; i++) await Promise.resolve();
  assert.equal(started, true);
  assert.equal(finished, false);
  accept();
  await pending;
  assert.equal(finished, true);
});

test("bridge delegates Mac SSH execution after admission but retains HTTP responses and local execution", async () => {
  const source = await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs", import.meta.url), "utf8");
  const auth = source.indexOf('if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`)');
  const admission = source.indexOf("await coordinateJobAdmission({", auth);
  const remoteBranch = source.indexOf('if (route.executionHost === "macos")', admission);
  const remote = source.indexOf("await coordinateRemoteExecution({", remoteBranch);
  const local = source.indexOf("await coordinateLocalExecution({", remote);
  assert.ok(auth >= 0 && auth < admission && admission < remoteBranch &&
    remoteBranch < remote && remote < local);
  assert.match(source, /return sendJson\(response, remote\.status, remote\.body\)/);
  assert.match(source, /const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(source, /server\.listen\(PORT, HOST,/);
});
