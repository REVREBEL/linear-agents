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
