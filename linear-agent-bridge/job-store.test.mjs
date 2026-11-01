import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobStore } from "./job-store.mjs";

test("claims each delivery only once, including across store instances", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  const first = await store.claim("gemini:delivery-1", { agent: "gemini" });
  assert.equal(first.created, true);
  const second = await createJobStore(root).claim("gemini:delivery-1", { agent: "gemini" });
  assert.equal(second.created, false);
  assert.equal(second.record.state, "received");
  assert.equal((await store.claim("trae:delivery-1", { agent: "trae" })).created, true);
});

test("serialized transitions preserve the latest process state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  await store.claim("antigravity:42", {});
  await Promise.all([
    store.transition("antigravity:42", "running", { pid: 123 }),
    store.transition("antigravity:42", "completed", { exitCode: 0 }),
  ]);
  const final = await store.get("antigravity:42");
  assert.equal(final.state, "completed");
  assert.equal(final.pid, 123);
});

test("startup reconciliation flags ambiguous work without re-executing it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  await store.claim("gemini:active", {});
  await store.transition("gemini:active", "running");
  await store.claim("gemini:done", {});
  await store.transition("gemini:done", "completed");
  await store.claim("chatgpt:external", {});
  await store.transition("chatgpt:external", "awaiting_external");
  assert.equal(await createJobStore(root).reconcile(), 1);
  assert.equal((await store.get("gemini:active")).state, "interrupted");
  assert.equal((await store.get("gemini:done")).state, "completed");
  assert.equal((await store.get("chatgpt:external")).state, "awaiting_external");
});

test("conversation lookup resumes only the latest exact Linear session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  await store.claim("antigravity:older", { agent: "antigravity", workspace: "/repo", agentSessionId: "session-1" });
  await store.transition("antigravity:older", "completed", { conversationId: "conversation-old" });
  await store.claim("antigravity:newer", { agent: "antigravity", workspace: "/repo", agentSessionId: "session-1" });
  await store.transition("antigravity:newer", "running", { conversationId: "conversation-new" });
  await store.claim("antigravity:other", { agent: "antigravity", workspace: "/repo", agentSessionId: "session-2" });
  await store.transition("antigravity:other", "running", { conversationId: "conversation-other" });

  assert.equal(
    (await store.findLatestConversationBySessionId("session-1", "antigravity:newer", "/repo")).conversationId,
    "conversation-old",
  );
  assert.equal(await store.findLatestConversationBySessionId("missing"), null);
});

test("workspace and verified timestamp scope conversation reuse", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  await store.claim("antigravity:first", { agent: "antigravity", workspace: "/one", agentSessionId: "s" });
  await store.transition("antigravity:first", "running", { conversationId: "conversation-one", conversationVerifiedAt: "2026-01-02T00:00:00Z" });
  await store.claim("antigravity:second", { agent: "antigravity", workspace: "/two", agentSessionId: "s" });
  await store.transition("antigravity:second", "running", { conversationId: "conversation-two", conversationVerifiedAt: "2026-01-03T00:00:00Z" });
  assert.equal((await store.findLatestConversationBySessionId("s", null, "/one")).conversationId, "conversation-one");
  assert.equal((await store.findLatestConversationBySessionId("s", null, "/other")), null);
});

test("issue recovery requires same issue and workspace, different session, verified completed AGY", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linear-issue-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createJobStore(root);
  const add = async (key, fields, state = "completed") => {
    await store.claim(key, { agent: "antigravity", issueId: "issue-1", workspace: "/repo", agentSessionId: key, ...fields });
    await store.transition(key, state, { conversationId: key, conversationVerifiedAt: "2026-11-01T00:00:00Z" });
  };
  await add("session-old", {});
  await add("session-active", {}, "running");
  await add("session-other-issue", { issueId: "issue-2" });
  await add("session-other-workspace", { workspace: "/other" });
  await add("session-unverified", {});
  await store.transition("session-unverified", "completed", { conversationVerifiedAt: null });
  const found = await store.findLatestCompletedConversationByIssueId("issue-1", "new-session", "/repo");
  assert.equal(found.key, "session-old");
  assert.equal(await store.findLatestCompletedConversationByIssueId("issue-1", "session-old", "/repo"), null);
  assert.equal(await store.findLatestCompletedConversationByIssueId("issue-1", "new-session", "/unknown"), null);
  assert.equal(await store.findLatestCompletedConversationByIssueId(null, "new-session", "/repo"), null);
});
