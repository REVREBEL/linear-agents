import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile, access } from "node:fs/promises";
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
  let invoked = 0;
  assert.equal(await retrieveMemuMemory("query", {
    enabled: false, spawnImpl: () => { invoked++; throw Error("Spawn forbidden"); },
  }), "");
  assert.equal(invoked, 0);
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

test("memU prepare snapshots validated bytes and never runs on failed proof", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memu-prepare-"));
  try {
    const input = path.join(dir, "session.json"), proof = path.join(dir, "proof.json");
    const cli = path.join(dir, "fake-memu");
    const marker = path.join(dir, "calls.txt");
    await writeFile(input, JSON.stringify(session));
    await writeFile(proof, JSON.stringify(verified));
    await writeFile(cli, [
      "#!/bin/sh",
      'test "$1" = memorize && test "$2" = prepare && test "$4" = --json || exit 2',
      'test "$3" != "' + input + '" || exit 3',
      'test -r "$3" || exit 4',
      'cat "$3" > "' + marker + '"',
      "printf '%s' '{\\"jobs\\":[\\"job1\\"],\\"executor_prompt\\":\\"evolve\\",\\"next_command\\":\\"memu memorize commit\\"}'",
      "",
    ].join("\n"));
    await chmod(cli, 0o700);
    const result = await prepareMemuPromotion(input, proof, cli);
    assert.deepEqual(result.jobs, ["job1"]);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), session);
    await rm(marker);
    await writeFile(proof, JSON.stringify({ ...verified, tests: { status: "failed", headSha: "a".repeat(40) } }));
    await assert.rejects(() => prepareMemuPromotion(input, proof, cli), /Verified review/);
    await assert.rejects(access(marker), error => error.code === "ENOENT");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
