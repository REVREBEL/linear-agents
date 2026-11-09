import test from "node:test";
import assert from "node:assert/strict";
import { sendTraeCompletion } from "./agents/trae/scripts/complete.mjs";
test("explicit Trae completion sends only job token and result, not bridge secret", async () => {
  let url, request;
  const result = await sendTraeCompletion({
    status: "completed", body: "Reviewed and tested",
    workspace: "/Users/test/rebel/example",
    readContext: async () => ({
      token: "a".repeat(64), jobKey: "trae:delivery",
      agentSessionId: "session", workspace: "/Users/test/rebel/example",
      completionEndpoint: "https://trae-agent.revrebel.io/trae-complete",
    }),
    fetchImpl: async (endpoint, options) => {
      url = endpoint; request = options;
      return { ok: true, async json() { return { ok: true }; } };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(url, "https://trae-agent.revrebel.io/trae-complete");
  const payload = JSON.parse(request.body);
  assert.equal(payload.status, "completed");
  assert.equal(payload.jobKey, "trae:delivery");
  assert.equal(payload.token, "a".repeat(64));
  assert.equal("bridgeSharedSecret" in payload, false);
});
test("Trae completion refuses ambiguous status", async () => {
  await assert.rejects(() => sendTraeCompletion({ status: "stopped", body: "done" }), /Usage/);
});
