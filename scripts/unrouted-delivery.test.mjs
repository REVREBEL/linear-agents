import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistUnroutedJob } from "../jobs/unrouted-delivery.mjs";

test("unrouted delivery writes the original task and transitions ledger before rejecting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-unrouted-"));
  try {
    const dir = path.join(root, "gemini");
    await fs.mkdir(dir);
    const order = [];
    const job = { payload: { data: { promptContext: "Fix issue" } } };
    const file = path.join(dir, "delivery-1.unrouted.json");
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
      path.join(dir, "delivery-2.unrouted.json"), "utf8",
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

test("bridge retains authentication/preflight and claim before unrouted handling", async () => {
  const src = await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs", import.meta.url), "utf8");
  const auth = src.indexOf('if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`)');
  const preflight = src.indexOf("await preflightLinearJob({", auth);
  const claim = src.indexOf("const claimed = await jobStore.claim(", preflight);
  const unrouted = src.indexOf("await persistUnroutedJob({", claim);
  const remote = src.indexOf('if (route.executionHost === "macos")', unrouted);
  assert.ok(auth >= 0 && auth < preflight && preflight < claim && claim < unrouted && unrouted < remote);
  assert.match(src, /return sendJson\(response, unrouted\.status, unrouted\.body\)/);
  assert.match(src, /const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
});
