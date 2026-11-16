import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgyProjectConversationStore } from "../conversations/agy-project-conversations.mjs";

test("project conversation store returns null for missing entries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-agy-project-missing-"));
  try {
    const store = createAgyProjectConversationStore(dir);
    assert.equal(await store.readAgyProjectConversation("project-1", "/repo"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("project conversation store preserves original data path and 0600 file mode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-agy-project-store-"));
  try {
    const store = createAgyProjectConversationStore(dir);
    const id = "conv_project_12345";
    await store.saveAgyProjectConversation("project-1", "/repo/one", id);
    const saved = path.join(dir, "project-conversations", "project-1.json");
    const raw = JSON.parse(await fs.readFile(saved, "utf8"));
    assert.equal(raw.projectId, "project-1");
    assert.equal(raw.workspace, "/repo/one");
    assert.equal(raw.conversationId, id);
    assert.ok(!Number.isNaN(Date.parse(raw.updatedAt)));
    assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
    assert.equal(await store.readAgyProjectConversation("project-1", "/repo/one"), id);
    assert.equal(await store.readAgyProjectConversation("project-1", "/repo/two"), null);
    assert.deepEqual(await fs.readdir(path.dirname(saved)), ["project-1.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("project conversation validation refuses unsafe IDs before touching disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-agy-project-invalid-"));
  try {
    const store = createAgyProjectConversationStore(dir);
    for (const id of ["", "short", "spaces in ID", "bad/identifier", "a".repeat(129)]) {
      await assert.rejects(store.saveAgyProjectConversation("project-1", "/repo", id), /invalid AGY conversation ID/);
    }
    await assert.rejects(fs.access(path.join(dir, "project-conversations")), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("existing project-conversation records remain readable without migration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-agy-project-legacy-"));
  try {
    const root = path.join(dir, "project-conversations");
    await fs.mkdir(root, { recursive: true });
    const valid = "legacy_conv_12345";
    await fs.writeFile(path.join(root, "project-1.json"), JSON.stringify({
      projectId: "project-1", workspace: "/repo", conversationId: valid,
      updatedAt: "2026-11-09T00:00:00.000Z"
    }));
    const store = createAgyProjectConversationStore(dir);
    assert.equal(await store.readAgyProjectConversation("project-1", "/repo"), valid);
    assert.equal(await store.readAgyProjectConversation("project-1", "/different"), null);
    await fs.writeFile(path.join(root, "project-2.json"), JSON.stringify({workspace: "/repo", conversationId: "bad"}));
    assert.equal(await store.readAgyProjectConversation("project-2", "/repo"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bridge uses shared AGY store while anchoring data at its original JOBS_DIR", async () => {
  const source = await fs.readFile(new URL("../bridge/server/agent-bridge-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/conversations\/agy-project-conversations\.mjs"/);
  assert.match(source, /createAgyProjectConversationStore\(JOBS_DIR\)/);
  assert.match(source, /const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(source, /readAgyProjectConversation,/);
  assert.match(source, /saveAgyProjectConversation,/);
});

test("unsafe project IDs fail closed before any filesystem access", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-agy-project-path-"));
  try {
    const store = createAgyProjectConversationStore(dir);
    for (const projectId of [
      "../outside", "../../private", "team/project", "team\\\\project",
      ".", "..", "", "spaces here", "project.json/../outside", "a".repeat(129)
    ]) {
      await assert.rejects(store.readAgyProjectConversation(projectId, "/repo"), /Invalid AGY project ID/);
      await assert.rejects(store.saveAgyProjectConversation(projectId, "/repo", "conversation_12345"), /Invalid AGY project ID/);
    }
    await assert.rejects(fs.access(path.join(dir, "project-conversations")), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("project identity must match stored record even when workspace and conversation ID are valid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-agy-project-swap-"));
  try {
    const store = createAgyProjectConversationStore(dir);
    await store.saveAgyProjectConversation("project-a", "/shared/repo", "conversation_aaa123");
    await store.saveAgyProjectConversation("project-b", "/shared/repo", "conversation_bbb123");
    const fileA = path.join(dir, "project-conversations", "project-a.json");
    const fileB = path.join(dir, "project-conversations", "project-b.json");
    const bytesA = await fs.readFile(fileA);
    const bytesB = await fs.readFile(fileB);
    await fs.writeFile(fileA, bytesB);
    await fs.writeFile(fileB, bytesA);
    assert.equal(await store.readAgyProjectConversation("project-a", "/shared/repo"), null);
    assert.equal(await store.readAgyProjectConversation("project-b", "/shared/repo"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
