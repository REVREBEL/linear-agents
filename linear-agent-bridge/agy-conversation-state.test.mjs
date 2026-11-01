import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobStore } from "./job-store.mjs";
import { recordResumedConversation } from "./agy-conversation-state.mjs";

test("follow-up retains inherited conversation ID even without a fresh AGY event", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-resume-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  await store.claim("antigravity:follow-up", {
    agent: "antigravity", agentSessionId: "session-1", workspace: "/repo",
  });
  await store.transition("antigravity:follow-up", "launching");
  await recordResumedConversation(store, "antigravity:follow-up", "conversation-original");
  await store.transition("antigravity:follow-up", "running", { pid: 123 });
  await store.transition("antigravity:follow-up", "completed", { pid: null, exitCode: 0 });
  const record = await store.get("antigravity:follow-up");
  assert.equal(record.state, "completed");
  assert.equal(record.conversationId, "conversation-original");
  assert.equal(record.resumedConversationId, "conversation-original");
  assert.equal(record.conversationSource, "follow_up");
  assert.equal(record.conversationVerifiedAt, undefined);
});

test("fresh conversations are not falsely described as resumed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fresh-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  await store.claim("antigravity:new", { agent: "antigravity" });
  await recordResumedConversation(store, "antigravity:new", null);
  const record = await store.get("antigravity:new");
  assert.equal(record.conversationId, undefined);
  assert.equal(record.resumedConversationId, undefined);
});

test("issue recovery records source and predecessor without claiming verification", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-issue-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  await store.claim("antigravity:issue-recovery", {
    agent: "antigravity", agentSessionId: "replacement-session",
    issueId: "issue-1", workspace: "/repo",
  });
  await store.transition("antigravity:issue-recovery", "launching", {
    recoveredFromAgentSessionId: "former-session",
    recoveredFromJobKey: "antigravity:original",
  });
  await recordResumedConversation(store, "antigravity:issue-recovery", "verified-prior-conversation", "issue_recovery");
  const record = await store.get("antigravity:issue-recovery");
  assert.equal(record.conversationSource, "issue_recovery");
  assert.equal(record.resumedConversationId, "verified-prior-conversation");
  assert.equal(record.recoveredFromAgentSessionId, "former-session");
  assert.equal(record.recoveredFromJobKey, "antigravity:original");
  assert.equal(record.conversationVerifiedAt, undefined);
});
