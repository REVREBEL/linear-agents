import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runBridgeSmoke } from "./p5-bridge-smoke.mjs";
import { createDiagnosticRoutes } from "../bridge/diagnostic-routes.mjs";
import { createJobStore } from "../jobs/job-store.mjs";
import { identifyLinearJobDelivery, linearJobDuplicateResponse } from "../jobs/job-admission.mjs";
import { canRecoverUnroutedDelivery } from "../jobs/unrouted-delivery.mjs";

async function withServer({ secret = "fixture-only-secret", routeOverride } = {}, run) {
  const handle = createDiagnosticRoutes({
    sharedSecret: secret, health: { testFixture: true },
    agentForHost: () => "mock",
  });
  const server = http.createServer((req, res) => {
    if (routeOverride?.(req, res)) return;
    const url = new URL(req.url || "/", "http://localhost");
    if (handle(req, res, { host: req.headers.host, url })) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await run({ port, secret });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("P5 loopback smoke exercises real HTTP health, unauthorized probe, and authenticated probe", async () => {
  await withServer({}, async ({ port, secret }) => {
    const messages = [];
    const result = await runBridgeSmoke({
      port, sharedSecret: secret, logger: { log: value => messages.push(value) },
    });
    assert.deepEqual(result, {
      ok: true, service: "local-linear-agent-router", agent: "mock",
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].includes(secret), false);
  });
});

test("P5 smoke fails closed with wrong secret and never calls /jobs", async () => {
  let requestedJobs = 0;
  await withServer({ routeOverride: (req) => {
    if (req.url === "/jobs") requestedJobs++;
    return false;
  } }, async ({ port }) => {
    await assert.rejects(runBridgeSmoke({
      port, sharedSecret: "wrong-secret", logger: { log: () => {} },
    }), /Authenticated diagnostic probe/);
    assert.equal(requestedJobs, 0);
  });
});

test("P5 smoke rejects malformed port, empty credentials and invalid probe ID before any request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error("unexpected fetch"); };
  for (const args of [
    { port: 0, sharedSecret: "test" },
    { port: "not-a-port", sharedSecret: "test" },
    { port: 65536, sharedSecret: "test" },
    { port: 8788, sharedSecret: "" },
    { port: 8788, sharedSecret: "test", probeId: "invalid" },
  ]) await assert.rejects(runBridgeSmoke({ ...args, fetchImpl }));
  assert.equal(calls, 0);
});

test("P5 smoke never accepts a spoofed healthy response or unauthenticated probe success", async () => {
  await withServer({
    routeOverride: (req, res) => {
      if (req.url !== "/diagnostics/probe" || req.headers.authorization) return false;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    },
  }, async ({ port, secret }) => {
    await assert.rejects(runBridgeSmoke({
      port, sharedSecret: secret, logger: { log: () => {} },
    }), /Unauthenticated diagnostic probe/);
  });
});

test("P5 job ledger reconciliation marks active work interrupted without relaunch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-p5-ledger-"));
  try {
    const store = createJobStore(root);
    const keys = ["received", "queued", "launching", "running", "completed", "failed", "unrouted"];
    for (const state of keys) {
      const key = "mock:" + state;
      await store.claim(key, { agent: "mock", deliveryId: state, jobId: state });
      if (state !== "received") await store.transition(key, state);
    }
    const restartedStore = createJobStore(root);
    assert.equal(await restartedStore.reconcile(), 4);
    for (const state of keys) {
      const record = await restartedStore.get("mock:" + state);
      if (["received", "queued", "launching", "running"].includes(state)) {
        assert.equal(record.state, "interrupted");
        assert.equal(record.previousState, state);
      } else assert.equal(record.state, state);
    }
    assert.equal(await restartedStore.reconcile(), 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("P5 durable duplicate keys reject uncertain work and ACK only accepted state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-p5-duplicate-"));
  try {
    const store = createJobStore(root);
    const headers = { "x-linear-webhook-id": "upstream:delivery/one" };
    const identity = identifyLinearJobDelivery({
      headers, rawBody: '{"job":"one"}', agent: "trae",
    });
    const created = await store.claim(identity.jobKey, {
      agent: "trae", deliveryId: identity.deliveryId, jobId: identity.safeJobId,
    });
    assert.equal(created.created, true);
    const duplicate = await createJobStore(root).claim(identity.jobKey, {
      agent: "trae", deliveryId: identity.deliveryId, jobId: identity.safeJobId,
    });
    assert.equal(duplicate.created, false);
    assert.equal(linearJobDuplicateResponse(duplicate, identity.safeJobId, "trae.test").status, 503);
    await store.transition(identity.jobKey, "running");
    const running = await createJobStore(root).claim(identity.jobKey, {});
    assert.equal(linearJobDuplicateResponse(running, identity.safeJobId, "trae.test").status, 202);
    const otherAgent = identifyLinearJobDelivery({
      headers, rawBody: '{"job":"one"}', agent: "gemini",
    });
    assert.notEqual(identity.jobKey, otherAgent.jobKey);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("P5 recovery never treats an interrupted launched job as safe unrouted replay", () => {
  const route = { ok: false, error: "No project" };
  const record = { key: "trae:delivery", agent: "trae", state: "interrupted" };
  const f = state => canRecoverUnroutedDelivery({
    claimed: { created: false, record: { ...record, previousState: state } },
    jobKey: record.key, agent: "trae", route,
  });
  assert.equal(f("received"), true);
  for (const unsafe of ["queued", "launching", "running", "completed"]) {
    assert.equal(f(unsafe), false);
  }
});

test("P5 smoke CLI fixes loopback target instead of accepting external URLs", async () => {
  const source = await fs.readFile(new URL("./p5-bridge-smoke.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("http://127.0.0.1:"));
  assert.equal(source.includes("fetchImpl(base + endpoint"), true);
  assert.equal(source.includes('request("/jobs"'), false);
});
