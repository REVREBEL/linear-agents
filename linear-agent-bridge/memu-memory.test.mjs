import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { compactRecall, retrieveMemuMemory } from "./memu-memory.mjs";
import { validatePromotion, prepareMemuPromotion } from "../scripts/memu-promote.mjs";

test("recall is compact and ignores unsupported formats", () => {
  assert.equal(compactRecall({ hits: [{ description: "Build", text: "Run tests" }] }), "Build: Run tests");
  assert.equal(compactRecall({ hits: "not an array" }), "");
  assert.ok(compactRecall({ hits: Array.from({length: 10}, () => ({text:"x".repeat(1000)})) }).length <= 2500);
});

test("disabled recall never starts a subprocess", async () => {
  assert.equal(await retrieveMemuMemory("query", { enabled: false, binary: "/does-not-exist" }), "");
});

test("enabled recall tolerates absent executable", async () => {
  assert.equal(await retrieveMemuMemory("query", { enabled: true, binary: "/does-not-exist" }), "");
});

const verified = {
  issueId: "issue-123", review: { status: "approved", headSha: "a".repeat(40) },
  tests: { status: "passed", headSha: "a".repeat(40) },
};
const session = { schema_version: "1.0", items: [{ type: "message", role: "user", content: "Original task" }] };

test("promotion gate rejects unverified or invented sessions", () => {
  assert.deepEqual(validatePromotion(session, verified), { issueId: "issue-123", headSha: "a".repeat(40) });
  assert.throws(() => validatePromotion({ ...session, items: [] }, verified));
  assert.throws(() => validatePromotion(session, { ...verified, tests: {status:"failed",headSha:"a".repeat(40)} }));
  assert.throws(() => validatePromotion(session, { ...verified, review: {status:"approved",headSha:"b".repeat(40)} }));
});

test("memU prepare obeys verified gate and forwards canonical session path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memu-prepare-"));
  try {
    const input = path.join(dir, "session.json"), proof = path.join(dir, "proof.json");
    const cli = path.join(dir, "fake-memu");
    await writeFile(input, JSON.stringify(session));
    await writeFile(proof, JSON.stringify(verified));
    const shell = [
      "#!/bin/sh",
      "[ \"$1\" = \"memorize\" ] && [ \"$2\" = \"prepare\" ] && [ \"$3\" = \"" + input + "\" ] && [ \"$4\" = \"--json\" ] || exit 2",
      "printf '%s' '{\"jobs\":[\"job1\"],\"executor_prompt\":\"evolve\",\"next_command\":\"memu memorize commit\"}'",
      "",
    ].join("\n");
    await writeFile(cli, shell);
    await chmod(cli, 0o700);
    const result = await prepareMemuPromotion(input, proof, cli);
    assert.deepEqual(result.jobs, ["job1"]);
    await writeFile(proof, JSON.stringify({ ...verified, tests: {status:"failed",headSha:"a".repeat(40)} }));
    await assert.rejects(() => prepareMemuPromotion(input, proof, cli), /Verified review/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
