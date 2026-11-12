import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDevOperations, makeGemmaDevTools } from "./dev-tools.mjs";
test("requires a task checkout under /home/rebel", async () => {
  await assert.rejects(createDevOperations({ workspace: os.tmpdir(), execute: async () => ({ stdout: os.tmpdir() }) }));
});
test("supports directory move and commit with an isolated fake filesystem, rejects protected branch", async () => {
  const calls = [];
  const root = "/home/rebel/gemma-test-repo";
  const fake = {
    realpath: async () => root,
    lstat: async () => ({ isSymbolicLink: () => false }),
    mkdir: async (...x) => { calls.push(["mkdir", ...x]); },
    rename: async (...x) => { calls.push(["rename", ...x]); },
    readFile: async () => "source",
    stat: async () => ({ isFile: () => true, size: 6 }),
    readdir: async () => [{ name: "src", isSymbolicLink: () => false, isDirectory: () => true }],
    writeFile: async (...x) => { calls.push(["writeFile", ...x]); },
    rm: async (...x) => { calls.push(["rm", ...x]); },
  };
  const exec = async (bin, args, options) => {
    calls.push(["command", bin, ...args]);
    return { stdout: args[0] === "rev-parse" ? root : args[0] === "branch" ? "feat/gemma\n" : "ok" };
  };
  const ops = await createDevOperations({ workspace: root, execute: exec, fsApi: fake });
  await ops.move("old/src", "agents/coding/src");
  await ops.write("src/index.mjs", "export {}");
  await ops.remove("old/tmp");
  await ops.runTest("typecheck");
  await ops.commit("refactor: move agent packages");
  assert.ok(calls.some(x => x[0] === "rename"));
  assert.ok(calls.some(x => x.includes("commit")));
  await assert.rejects(ops.write(".env", "secret"));
  await assert.rejects(ops.move(".git", "x"));
  await assert.rejects(ops.runTest("deploy"));
  await assert.rejects(ops.write("../elsewhere", "no"));
  await assert.rejects(createDevOperations({ workspace: root, fsApi: fake, execute: async (_b, args) => ({ stdout: args[0] === "rev-parse" ? root : "main\n" }) }));
});
test("SDK tools expose operations, no push, merge, deploy or unrestricted shell", () => {
  const sdk = { z: { string: () => "string", object: v => v }, tool: v => v };
  const ops = { list() {}, read() {}, write() {}, move() {}, remove() {}, runTest() {}, gitStatus() {}, gitDiff() {}, commit() {} };
  const tools = makeGemmaDevTools(ops, sdk);
  assert.deepEqual(tools.map(t => t.name), ["list_directory", "read_file", "write_file", "move_path", "delete_path", "run_test", "git_status", "git_diff", "git_commit"]);
});
