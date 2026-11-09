import test from "node:test";
import assert from "node:assert/strict";
import { probeTraeCallbacks, validateTraeCallbackBase } from "./check-trae-callbacks.mjs";

function mockResponse(status, error) {
  return {
    status,
    headers: { get: () => "application/json" },
    json: async () => ({ ok: false, error }),
  };
}
test("Trae callback verification recognizes exact Ubuntu denial responses", async () => {
  const urls = [];
  const results = await probeTraeCallbacks({
    host: "trae-agent.revrebel.io",
    fetchImpl: async (url, request) => {
      urls.push({ url, request });
      const complete = url.endsWith("/trae-complete");
      return complete ? mockResponse(401, "Invalid completion context") : mockResponse(400, "Invalid Trae workspace");
    },
  });
  assert.deepEqual(results.map(r => r.status), [400, 401]);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(r => r.request.method === "POST" && r.request.body === "{}"));
  assert.ok(urls.every(r => !r.request.headers.authorization));
});
test("Trae callback verification rejects WAF challenges, missing routes, and spoofed successes", async () => {
  for (const response of [
    mockResponse(403, "Forbidden"),
    mockResponse(404, "Not Found"),
    mockResponse(200, "Invalid Trae workspace"),
    mockResponse(400, "Different error"),
    { status: 302, headers: { get: () => "text/html" } },
  ]) {
    await assert.rejects(
      () => probeTraeCallbacks({ host: "trae-agent.revrebel.io", fetchImpl: async () => response }),
      /did not reach the expected Ubuntu handler/
    );
  }
});
test("Trae callback host cannot inject port, URL path or other destination", () => {
  assert.equal(validateTraeCallbackBase("trae-agent.revrebel.io"), "trae-agent.revrebel.io");
  for (const host of ["https://evil.example", "trae-agent.revrebel.io:8443",
    "trae-agent.revrebel.io/callback", "localhost", "bad hostname"]) {
    assert.throws(() => validateTraeCallbackBase(host));
  }
});
