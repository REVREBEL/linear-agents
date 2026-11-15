import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { createHttpRouteComposer as canonicalComposer } from "./http-route-composition.mjs";
import { createHttpRouteComposer as legacyComposer } from "../bridge/http-route-composition.mjs";
import { createDiagnosticRoutes as canonicalDiagnostics } from "../handlers/diagnostic-routes.mjs";
import { createDiagnosticRoutes as legacyDiagnostics } from "../bridge/diagnostic-routes.mjs";
import { createAgentHostResolver as canonicalHostResolver } from "../config/agent-host-resolver.mjs";
import { createAgentHostResolver as legacyHostResolver } from "../bridge/agent-host-resolver.mjs";
import { coordinateJobAdmission as canonicalAdmission } from "../orchestration/job-admission-coordinator.mjs";
import { coordinateJobAdmission as legacyAdmission } from "../jobs/job-admission-coordinator.mjs";

test("P5 structure: legacy modules re-export canonical function identities without duplicate state", () => {
  assert.strictEqual(canonicalComposer, legacyComposer);
  assert.strictEqual(canonicalDiagnostics, legacyDiagnostics);
  assert.strictEqual(canonicalHostResolver, legacyHostResolver);
  assert.strictEqual(canonicalAdmission, legacyAdmission);
});

test("P5 structure: canonical diagnostic handler preserves HTTP contract", () => {
  const diagnostic = canonicalDiagnostics({
    health: { alive: true }, sharedSecret: "local-test-secret",
    agentForHost: () => "trae",
  });
  function response() {
    return { status: 0, body: "",
      writeHead(status) { this.status = status; },
      end(body) { this.body = JSON.parse(body); },
    };
  }
  const health = response();
  assert.equal(diagnostic({ method: "GET", headers: {} }, health,
    { host: "localhost", url: new URL("http://localhost/health") }), true);
  assert.equal(health.status, 200);
  assert.equal(health.body.alive, true);
  const rejected = response();
  assert.equal(diagnostic({ method: "POST", headers: {} }, rejected,
    { host: "localhost", url: new URL("http://localhost/diagnostics/probe") }), true);
  assert.equal(rejected.status, 401);
});

test("P5 structure: canonical host resolver preserves ordered identities", () => {
  const resolve = canonicalHostResolver({
    mockHost: "mock.example.test", antigravityHost: "agy.example.test",
    chatgptHost: "chatgpt.example.test", chatgptCliHost: "cli.example.test",
    traeHost: "trae.example.test", geminiHost: "gemini.example.test",
    gemmaHost: "gemma.example.test",
  });
  assert.equal(resolve("trae.example.test"), "trae");
  assert.equal(resolve("cli.example.test"), "chatgpt-cli");
  assert.equal(resolve("unmatched.example.test"), "unknown");
});

test("P5 structure: bridge entrypoint uses canonical folders without moving runtime state", async () => {
  const bridge = await fs.readFile(new URL("../bridge/server/agent-bridge-runtime.mjs", import.meta.url), "utf8");
  for (const path of [
    "./http-route-composition.mjs",
    "../handlers/diagnostic-routes.mjs",
    "../config/agent-host-resolver.mjs",
    "../orchestration/job-admission-coordinator.mjs",
  ]) assert.ok(bridge.includes(`from "${path}"`), path);
  assert.ok(bridge.includes('const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs")'));
  assert.ok(bridge.includes('const server = http.createServer(async (request, response) => {'));
  assert.ok(bridge.includes('server.listen(PORT, HOST,'));
});

test("P5 structure: source owners reside in new folders and compatibility paths only re-export", async () => {
  for (const [canonicalPath, legacyPath, ownerExport] of [
    ["./http-route-composition.mjs", "../bridge/http-route-composition.mjs", "createHttpRouteComposer"],
    ["../handlers/diagnostic-routes.mjs", "../bridge/diagnostic-routes.mjs", "createDiagnosticRoutes"],
    ["../config/agent-host-resolver.mjs", "../bridge/agent-host-resolver.mjs", "createAgentHostResolver"],
    ["../orchestration/job-admission-coordinator.mjs", "../jobs/job-admission-coordinator.mjs", "coordinateJobAdmission"],
  ]) {
    const original = await fs.readFile(new URL(canonicalPath, import.meta.url), "utf8");
    const shim = await fs.readFile(new URL(legacyPath, import.meta.url), "utf8");
    assert.match(original, new RegExp("export (?:async )?function " + ownerExport + "\\("));
    assert.ok(shim.startsWith("export { " + ownerExport + " } from "));
    assert.equal(shim.includes("function " + ownerExport), false);
  }
});
