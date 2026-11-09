import test from "node:test";
import assert from "node:assert/strict";
import { hashRemoteToken, validateRemoteTraeActivity, validateActivityEndpoint, validateTraeCompletionUrl } from "./remote-trae-activity.mjs";

const token = "a".repeat(64);
const record = {
  key: "trae:delivery-1", agent: "trae", executionHost: "macos",
  state: "running", agentSessionId: "01234567-89ab-cdef-0123-456789abcdef",
  workspace: "/Users/test/rebel/linear-agents",
  remoteCompletionUrl: "https://linear-trae.revrebel.io/complete",
  remoteActivityTokenHash: hashRemoteToken(token),
};
const activity = {
  jobKey: record.key, token, agentSessionId: record.agentSessionId,
  workspace: record.workspace, body: "Running project checks"
};

test("remote Trae progress accepts only its own authenticated job context", () => {
  assert.equal(validateRemoteTraeActivity(activity, record), true);
  assert.equal(validateRemoteTraeActivity(activity, { ...record, state: "awaiting_external" }), true);
  assert.equal(validateRemoteTraeActivity({ ...activity, token: "b".repeat(64) }, record), false);
  assert.equal(validateRemoteTraeActivity({ ...activity, workspace: "/tmp/other" }, record), false);
  assert.equal(validateRemoteTraeActivity({ ...activity, agentSessionId: "another-session" }, record), false);
  assert.equal(validateRemoteTraeActivity({ ...activity, jobKey: "trae:other" }, record), false);
  assert.equal(validateRemoteTraeActivity(activity, { ...record, state: "completed" }), false);
  assert.equal(validateRemoteTraeActivity(activity, { ...record, executionHost: "bridge-server" }), false);
  assert.equal(validateRemoteTraeActivity(activity, null), false);
});
test("Mac activity endpoint is HTTPS on the configured Trae tunnel host only", () => {
  const url = "https://trae-agent.revrebel.io/trae-activity";
  assert.equal(validateActivityEndpoint(url, "trae-agent.revrebel.io"), url);
  for (const invalid of ["http://trae-agent.revrebel.io/trae-activity",
    "https://other.example/trae-activity",
    "https://trae-agent.revrebel.io/complete",
    "https://user:password@trae-agent.revrebel.io/trae-activity",
    "https://trae-agent.revrebel.io/trae-activity?redirect=https://evil.example"]) {
    assert.throws(() => validateActivityEndpoint(invalid, "trae-agent.revrebel.io"));
  }
});

test("Linear completion URL must belong to Trae Worker, not arbitrary HTTPS origin", () => {
  const url = "https://linear-trae.revrebel.io/complete";
  assert.equal(validateTraeCompletionUrl(url, "linear-trae.revrebel.io"), url);
  for (const bad of ["https://attacker.example/complete",
    "http://linear-trae.revrebel.io/complete",
    "https://linear-trae.revrebel.io/other",
    "https://linear-trae.revrebel.io/complete?redirect=1"]) {
    assert.throws(() => validateTraeCompletionUrl(bad, "linear-trae.revrebel.io"));
  }
});
