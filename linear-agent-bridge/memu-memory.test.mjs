import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, access } from "node:fs/promises";
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
  assert.equal(await retrieveMemuMemory("query", { enabled: true, binary: "/does-not-exist", scope: { tenantId: "org-one", agentId: "qwen-local", repositoryId: "repo", issueId: "ABR-87" } }), "");
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

test("memU preparation rejects unsupported CLI even with model-supplied success proof", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memu-prepare-"));
  try {
    const input = path.join(dir, "session.json"), proof = path.join(dir, "proof.json");
    const cli = path.join(dir, "fake-memu"), marker = path.join(dir, "calls.txt");
    await writeFile(input, JSON.stringify(session));
    await writeFile(proof, JSON.stringify(verified));
    await writeFile(cli, '#!/bin/sh\\nprintf called > "' + marker + '"\\n');
    await chmod(cli, 0o700);
    await assert.rejects(prepareMemuPromotion(input, proof, cli),
      /incomplete trusted job scope/);
    await assert.rejects(access(marker), { code: "ENOENT" });
    await writeFile(proof, JSON.stringify({ ...verified,
      tests: { status: "failed", headSha: "a".repeat(40) } }));
    await assert.rejects(prepareMemuPromotion(input, proof, cli),
      /Verified review/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unconfigured promotion never starts a stalled or malicious memU command", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memu-denied-"));
  try {
    const input = path.join(dir, "session.json"), proof = path.join(dir, "proof.json");
    const cli = path.join(dir, "stalled-memu"), marker = path.join(dir, "calls.txt");
    await writeFile(input, JSON.stringify(session));
    await writeFile(proof, JSON.stringify(verified));
    await writeFile(cli, '#!/bin/sh\\nprintf started > "' + marker + '"\\nexec sleep 30\\n');
    await chmod(cli, 0o700);
    await assert.rejects(prepareMemuPromotion(input, proof, cli),
      /incomplete trusted job scope/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("enabled memU failures warn without preventing task dispatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memu-warning-"));
  try {
    const cli = path.join(dir, "invalid-memu");
    const warnings = [];
    await writeFile(cli, "#!/bin/sh\nprintf '%s' 'invalid-json'\n");
    await chmod(cli, 0o700);
    const result = await retrieveMemuMemory("repo", {
      enabled: true, binary: cli, scope: { tenantId: "org-one", agentId: "qwen-local", repositoryId: "repo", issueId: "ABR-87" }, logger: { warn: message => warnings.push(message) },
    });
    assert.equal(result, "");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid response/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
