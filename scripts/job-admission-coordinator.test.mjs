import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { coordinateJobAdmission } from "../jobs/job-admission-coordinator.mjs";

function fixture(overrides = {}) {
  const steps = [];
  const identity = { safeJobId: "safe-id", deliveryId: "raw/id", jobKey: "trae:raw/id" };
  const route = { ok: true, executionHost: "linux", repositoryRoot: "/repo" };
  const credential = { accessToken: "test-token" };
  const claimed = { created: true, record: { key: identity.jobKey, agent: "trae", state: "received" } };
  const args = {
    headers: { "x-linear-webhook-id": "raw/id" },
    rawBody: '{"task":"hello"}', job: { task: "hello" },
    host: "trae.example.test", agent: "trae", sharedSecret: "secret",
    resolveJobRoute: async () => route,
    syncLinearCredential: async () => credential,
    checkOpenCodeReady: async () => true,
    agentJobDirs: { trae: "/private/jobs/trae" },
    jobStore: {
      claim: async (...params) => { steps.push(["claim", ...params]); return claimed; },
    },
    identifyDelivery: options => { steps.push(["identity", options]); return identity; },
    preflight: async options => {
      steps.push(["preflight", options]);
      return { route, credential, rejection: null };
    },
    duplicateResponseFor: (...params) => {
      steps.push(["duplicate", ...params]);
      return null;
    },
    recoverableUnrouted: params => {
      steps.push(["recovery-check", params]);
      return false;
    },
    handleUnrouted: async options => {
      steps.push(["unrouted", options]);
      return null;
    },
    ...overrides,
  };
  return { args, steps, identity, route, credential, claimed };
}

test("success performs identity, preflight, durable claim and duplicate check in order", async () => {
  const f = fixture();
  const result = await coordinateJobAdmission(f.args);
  assert.deepEqual(f.steps.map(step => step[0]),
    ["identity", "preflight", "claim", "recovery-check", "duplicate", "unrouted"]);
  assert.deepEqual(f.steps[2], ["claim", f.identity.jobKey, {
    agent: "trae", deliveryId: "raw/id", jobId: "safe-id",
  }]);
  assert.deepEqual(result, { delivery: {
    ...f.identity, agent: "trae", route: f.route, credential: f.credential,
  } });
  assert.equal(f.steps[1][1].sharedSecret, "secret");
  assert.equal(f.steps[5][1].jobStore, f.args.jobStore);
});

test("preflight rejection never claims a delivery", async () => {
  const f = fixture({ preflight: async () => ({
    route: null, credential: null,
    rejection: { status: 503, body: { ok: false, accepted: false, error: "credentials offline" } },
  }) });
  const result = await coordinateJobAdmission(f.args);
  assert.deepEqual(result, { response: {
    status: 503, body: { ok: false, accepted: false, error: "credentials offline" },
  } });
  assert.deepEqual(f.steps.map(s => s[0]), ["identity"]);
});

test("preflight exception also leaves delivery unclaimed", async () => {
  const f = fixture({ preflight: async () => { throw Error("credential network failure"); } });
  await assert.rejects(coordinateJobAdmission(f.args), /credential network failure/);
  assert.deepEqual(f.steps.map(s => s[0]), ["identity"]);
});

test("duplicate active delivery returns its existing 202 without launching or persisting", async () => {
  const f = fixture({
    jobStore: { claim: async () => ({ created: false, record: { state: "running", jobId: "old-id", agent: "trae" } }) },
    duplicateResponseFor: () => ({ status: 202, body: {
      ok: true, accepted: true, duplicate: true, jobId: "old-id", state: "running", host: "trae.example.test",
    } }),
  });
  const result = await coordinateJobAdmission(f.args);
  assert.equal(result.response.status, 202);
  assert.equal(result.response.body.jobId, "old-id");
  assert.deepEqual(f.steps.map(s => s[0]), ["identity", "preflight", "recovery-check"]);
});

test("unaccepted duplicate returns 503 without dispatch", async () => {
  const f = fixture({
    jobStore: { claim: async () => ({ created: false, record: { state: "failed" } }) },
    duplicateResponseFor: () => ({ status: 503, body: { ok: false, accepted: false, duplicate: true } }),
  });
  const result = await coordinateJobAdmission(f.args);
  assert.deepEqual(result.response, { status: 503, body: {
    ok: false, accepted: false, duplicate: true,
  } });
  assert.deepEqual(f.steps.map(s => s[0]), ["identity", "preflight", "recovery-check"]);
});

test("recovered received-only unrouted claim bypasses duplicate guard and persists 422", async () => {
  const f = fixture({
    preflight: async () => ({ route: { ok: false, error: "No routing" }, credential: null, rejection: null }),
    jobStore: { claim: async () => ({ created: false, record: {
      key: "trae:raw/id", agent: "trae", state: "interrupted", previousState: "received",
    } }) },
    recoverableUnrouted: () => true,
    duplicateResponseFor: () => { throw Error("recoverable job must not hit duplicate check"); },
    handleUnrouted: async () => ({ status: 422, body: {
      ok: false, accepted: false, error: "No routing",
    } }),
  });
  const result = await coordinateJobAdmission(f.args);
  assert.deepEqual(result.response, { status: 422, body: {
    ok: false, accepted: false, error: "No routing",
  } });
  assert.deepEqual(f.steps.map(s => s[0]), ["identity"]);
});

test("ledger failure propagates; no job receives a success acknowledgment", async () => {
  const f = fixture({ jobStore: { claim: async () => { throw Error("ledger disk error"); } } });
  await assert.rejects(coordinateJobAdmission(f.args), /ledger disk error/);
  assert.deepEqual(f.steps.map(s => s[0]), ["identity", "preflight"]);
});

test("unrouted persistence error propagates without accepting the job", async () => {
  const f = fixture({ handleUnrouted: async () => { throw Error("cannot write pending task"); } });
  await assert.rejects(coordinateJobAdmission(f.args), /cannot write pending task/);
  assert.deepEqual(f.steps.map(s => s[0]), ["identity", "preflight", "claim", "recovery-check", "duplicate"]);
});

test("bridge keeps authentication and body parsing before coordinator, dispatch after it", async () => {
  const src = await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs", import.meta.url), "utf8");
  const auth = src.indexOf('if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`)');
  const parse = src.indexOf("const job = JSON.parse(rawBody);", auth);
  const coordinator = src.indexOf("await coordinateJobAdmission({", parse);
  const resultCheck = src.indexOf("if (admission.response)", coordinator);
  const dispatch = src.indexOf('if (route.executionHost === "macos")', resultCheck);
  assert.ok(auth >= 0 && auth < parse && parse < coordinator && coordinator < resultCheck && resultCheck < dispatch);
  assert.match(src, /const \{ safeJobId, jobKey, route, credential \} = admission\.delivery;/);
  assert.match(src, /const server = http\.createServer\(async \(request, response\) => \{/);
  assert.match(src, /server\.listen\(PORT, HOST,/);
});
