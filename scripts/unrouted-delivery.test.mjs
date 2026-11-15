import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistUnroutedJob, unroutedTaskPath, canRecoverUnroutedDelivery, handleUnroutedDelivery } from "../jobs/unrouted-delivery.mjs";

test("unrouted delivery writes the original task and transitions ledger before rejecting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-"));
  try {
    const dir = path.join(root, "gemini");
    await fs.mkdir(dir);
    const order = [];
    const job = { payload: { data: { promptContext: "Fix issue" } } };
    const file = unroutedTaskPath({ agent: "gemini", safeJobId: "delivery-1", jobKey: "gemini:delivery-1", agentJobDirs: { gemini: dir } });
    const result = await persistUnroutedJob({
      agent: "gemini", safeJobId: "delivery-1", jobKey: "gemini:delivery-1", job,
      route: { ok: false, error: "Project not configured" }, agentJobDirs: { gemini: dir },
      jobStore: { transition: async (key, state, changes) => {
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        assert.deepEqual(saved, { reason: "Project not configured", job });
        order.push([key, state, changes]);
      } },
      logger: { error: message => order.push(message) },
    });
    assert.deepEqual(result, {
      status: 422, body: { ok: false, accepted: false, error: "Project not configured" },
    });
    assert.deepEqual(order, [
      ["gemini:delivery-1", "unrouted", { error: "Project not configured", taskFile: file }],
      `Routing failed: Project not configured; saved pending job to ${file}`,
    ]);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unrouted delivery fails closed if durable ledger transition fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-failure-"));
  try {
    const dir = path.join(root, "mock");
    await fs.mkdir(dir);
    const logs = [];
    await assert.rejects(persistUnroutedJob({
      agent: "mock", safeJobId: "delivery-2", jobKey: "mock:delivery-2",
      job: { task: "unchanged" }, route: { ok: false, error: "Unknown project" },
      agentJobDirs: { mock: dir },
      jobStore: { transition: async () => { throw Error("Ledger unavailable"); } },
      logger: { error: message => logs.push(message) },
    }), /Ledger unavailable/);
    assert.deepEqual(logs, []);
    assert.deepEqual(JSON.parse(await fs.readFile(
      unroutedTaskPath({ agent: "mock", safeJobId: "delivery-2", jobKey: "mock:delivery-2", agentJobDirs: { mock: dir } }), "utf8",
    )), { reason: "Unknown project", job: { task: "unchanged" } });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unrouted delivery cannot claim success when task write fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-nowrite-"));
  try {
    let transitioned = false;
    await assert.rejects(persistUnroutedJob({
      agent: "mock", safeJobId: "delivery-3", jobKey: "mock:delivery-3",
      job: {}, route: { ok: false, error: "Unknown project" },
      agentJobDirs: { mock: path.join(root, "missing-dir") },
      jobStore: { transition: async () => { transitioned = true; } },
      logger: { error: () => { throw Error("must not log accepted"); } },
    }), { code: "ENOENT" });
    assert.equal(transitioned, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge retains authentication before coordinator, with unrouted persistence after claim", async () => {
  const src = await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs", import.meta.url), "utf8");
  const coordinator = await fs.readFile(new URL("../bridge/orchestration/job-admission-coordinator.mjs", import.meta.url), "utf8");
  const auth = src.indexOf('if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`)');
  const delegate = src.indexOf("await coordinateJobAdmission({", auth);
  const remote = src.indexOf('if (route.executionHost === "macos")', delegate);
  const claim = coordinator.indexOf("const claimed = await jobStore.claim(");
  const unrouted = coordinator.indexOf("await handleUnrouted({", claim);
  assert.ok(auth >= 0 && auth < delegate && delegate < remote);
  assert.ok(claim >= 0 && claim < unrouted);
  assert.match(src, /return sendJson\(response, admission\.response\.status, admission\.response\.body\)/);
  assert.match(src, /const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
});

test("distinct ledger keys with colliding sanitized job IDs retain separate private files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-collision-"));
  try {
    const dir = path.join(root, "trae");
    await fs.mkdir(dir);
    const jobStore = { transition: async () => {} };
    const base = { agent: "trae", safeJobId: "a_b", route: { ok: false, error: "Unrouted" },
      agentJobDirs: { trae: dir }, jobStore, logger: { error: () => {} } };
    const a = { ...base, jobKey: "trae:a/b", job: { id: "first" } };
    const b = { ...base, jobKey: "trae:a?b", job: { id: "second" } };
    await Promise.all([persistUnroutedJob(a), persistUnroutedJob(b)]);
    const pA = unroutedTaskPath(a);
    const pB = unroutedTaskPath(b);
    assert.notEqual(pA, pB);
    assert.deepEqual(JSON.parse(await fs.readFile(pA, "utf8")).job, a.job);
    assert.deepEqual(JSON.parse(await fs.readFile(pB, "utf8")).job, b.job);
    for (const file of [pA,pB]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an interrupted persistence can be retried only for the original unlaunched claim", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-retry-"));
  try {
    const dir = path.join(root, "mock");
    await fs.mkdir(dir);
    let attempts = 0;
    const options = { agent: "mock", safeJobId: "delivery", jobKey: "mock:delivery",
      job: { id: "original" }, route: { ok: false, error: "Missing project" },
      agentJobDirs: { mock: dir }, logger: { error: () => {} },
      jobStore: { transition: async () => { if (++attempts === 1) throw Error("disk outage"); } }
    };
    await assert.rejects(persistUnroutedJob(options), /disk outage/);
    const claimed = { created: false, record: { agent: "mock", key: "mock:delivery", state: "received" } };
    assert.equal(canRecoverUnroutedDelivery({ claimed, route: options.route, jobKey: options.jobKey, agent: "mock" }), true);
    const response = await handleUnroutedDelivery(options);
    assert.equal(response.status, 422);
    assert.equal(attempts, 2);
    const file = unroutedTaskPath(options);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).job, options.job);
    assert.equal(canRecoverUnroutedDelivery({
      claimed: { created: false, record: { ...claimed.record, state: "interrupted", previousState: "received" } },
      route: options.route, jobKey: options.jobKey, agent: "mock" }), true);
    assert.equal(canRecoverUnroutedDelivery({
      claimed: { created: false, record: { ...claimed.record, state: "interrupted", previousState: "running" } },
      route: options.route, jobKey: options.jobKey, agent: "mock" }), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("existing pending file with different contents rejects replay without overwrite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-conflict-"));
  try {
    const dir = path.join(root, "gemini");
    await fs.mkdir(dir);
    const options = { agent: "gemini", safeJobId: "delivery", jobKey: "gemini:delivery",
      job: { id: "first" }, route: { ok: false, error: "Missing project" },
      agentJobDirs: { gemini: dir }, logger: { error: () => {} },
      jobStore: { transition: async () => {} } };
    await persistUnroutedJob(options);
    await assert.rejects(persistUnroutedJob({ ...options, job: { id: "changed" } }), /collision/);
    assert.deepEqual(JSON.parse(await fs.readFile(unroutedTaskPath(options), "utf8")).job, options.job);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("actual unrouted handler skips routed jobs and persists unresolved routes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-branch-"));
  try {
    const dir = path.join(root, "mock");
    await fs.mkdir(dir);
    let transitions = 0;
    const base = { agent: "mock", safeJobId: "id", jobKey: "mock:id", job: {},
      agentJobDirs: { mock: dir }, logger: { error: () => {} },
      jobStore: { transition: async () => { transitions++; } } };
    assert.equal(await handleUnroutedDelivery({ ...base, route: { ok: true } }), null);
    assert.equal(transitions, 0);
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal((await handleUnroutedDelivery({ ...base, route: { ok: false, error: "No route" } })).status, 422);
    assert.equal(transitions, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
