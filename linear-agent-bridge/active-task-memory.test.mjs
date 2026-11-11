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
    const lines = mem.recoveryPreamble(latest).split("\n")
      .filter(line => line.startsWith("Checkpoint: tool"));
    assert.deepEqual(lines.map(line => Number(line.match(/Step (\d+):/)?.[1])),
      [25, 26, 27, 28, 29, 30]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v2 retains incremental progress, sanitizes nested credentials and enforces revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-versioned-memory-"));
  try {
    const store = createActiveTaskMemory(root);
    const first = await store.update("repo", "issue-123", {
      state: "active", nextAction: "Run tests",
      artifacts: [{ path: "src/index.ts", privateToken: "do-not-store" }],
      source: { kind: "linear", metadata: { authorizationHeader: "Bearer hidden" } },
      lastVerifiedResult: "ghp_12345678901234567890123456789012345",
    });
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.revision, 1);
    assert.equal(first.artifacts[0].privateToken, "[REDACTED]");
    assert.equal(first.source.metadata.authorizationHeader, "[REDACTED]");
    assert.ok(!JSON.stringify(first).includes("do-not-store"));
    assert.ok(!JSON.stringify(first).includes("ghp_12345678901234567890123456789012345"));
    await store.progress("repo", "issue-123", { kind: "checkpoint", summary: "Step complete" });
    const current = await store.read("repo", "issue-123");
    assert.equal(current.revision, 2);
    assert.equal(current.progress.length, 1);
    await assert.rejects(
      store.update("repo", "issue-123", { expectedRevision: 1, nextAction: "Stale overwrite" }),
      error => error.code === "ECONFLICT",
    );
    assert.equal((await store.read("repo", "issue-123")).nextAction, "Run tests");
    assert.match(store.recoveryPreamble(current), /Next action: Run tests/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired checkpoints omit stale next actions and lifecycle mismatch fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-expired-memory-"));
  try {
    const store = createActiveTaskMemory(root);
    const expired = await store.update("repo", "issue-expired", {
      expiresAt: "2025-01-01T00:00:00Z", nextAction: "Dangerous stale instruction",
    });
    const preamble = store.recoveryPreamble(expired);
    assert.match(preamble, /EXPIRED/);
    assert.doesNotMatch(preamble, /Dangerous stale instruction/);
    await assert.rejects(
      store.update("repo", "issue-expired", { state: "active", status: "completed" }),
      /Invalid checkpoint lifecycle/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separate memory instances serialize concurrent progress using filesystem lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-crossproc-memory-"));
  try {
    const a = createActiveTaskMemory(root);
    const b = createActiveTaskMemory(root);
    await Promise.all([
      a.progress("repo", "issue-shared", { summary: "first" }),
      b.progress("repo", "issue-shared", { summary: "second" }),
    ]);
    const record = await a.read("repo", "issue-shared");
    assert.equal(record.progress.length, 2);
    assert.equal(record.revision, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
