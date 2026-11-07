import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createActiveTaskMemory } from "./active-task-memory.mjs";

test("active memory survives bridge restart and restores issue-scoped context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const first = createActiveTaskMemory(root);
    await first.update("/workspace/repo", "issue-12345678", {
      lastAgent: "antigravity", state: "active", lastSessionId: "session-abc123",
      lastVerifiedResult: "Tests not yet verified",
    });
    const second = createActiveTaskMemory(root);
    const previous = await second.read("/workspace/repo", "issue-12345678");
    assert.equal(previous.lastAgent, "antigravity");
    assert.equal(previous.lastVerifiedResult, "Tests not yet verified");
    assert.match(second.recoveryPreamble(previous), /Inspect the repository and tests/);
    assert.equal(await second.read("/workspace/repo2", "issue-12345678"), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent updates serialize and never leave truncated checkpoint files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.update("repo", "issue-12345678", {
      lastVerifiedResult: "stage-" + i,
    })));
    assert.equal((await store.read("repo", "issue-12345678")).lastVerifiedResult, "stage-7");
    const files = await readdir(path.join(root, "active-task-memory"));
    assert.equal(files.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("progress events are bounded, redacted, and survive restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-progress-"));
  try {
    const mem = createActiveTaskMemory(root);
    await Promise.all(Array.from({ length: 31 }, (_, i) =>
      mem.progress("repo", "issue-0123", {
        kind: "tool", summary: "Step " + i + ": edit_file API_KEY=supersecret"
      })));
    const latest = await createActiveTaskMemory(root).read("repo", "issue-0123");
    assert.equal(latest.progress.length, 20);
    assert.equal(latest.progress[0].summary.startsWith("Step 11:"), true);
    assert.ok(!JSON.stringify(latest).includes("supersecret"));
    assert.match(mem.recoveryPreamble(latest), /Checkpoint: tool/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
