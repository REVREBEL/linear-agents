import test from "node:test";
import assert from "node:assert/strict";
import { compactRecall, retrieveMemuMemory } from "./memu-memory.mjs";

test("memU 0.10 segment response yields bounded context", () => {
  assert.equal(compactRecall({ segments: [{ text: "PostgreSQL 18 port 5433" }], files: [{ content: "duplicate" }] }), "PostgreSQL 18 port 5433");
  assert.equal(compactRecall({ segments: [], files: [{ description: "Review", content: "check head SHA" }] }), "Review: check head SHA");
  assert.equal(compactRecall({ hits: [{ description: "Build", text: "Run tests" }] }), "Build: Run tests");
  assert.equal(compactRecall({ segments: [null, 1, { text: "x".repeat(9000) }] }).length, 600);
  assert.equal(compactRecall({ segments: Array.from({ length: 20 }, () => ({ text: "x".repeat(1000) })) }).length <= 2500, true);
  assert.equal(compactRecall({ segments: "invalid" }), "");
});

test("disabled recall never spawns", async () => {
  let calls = 0;
  assert.equal(await retrieveMemuMemory("query", { enabled: false, spawnImpl: () => { calls++; throw Error("unexpected"); } }), "");
  assert.equal(calls, 0);
});

test("enabled recall remains fail-open if executable is missing", async () => {
  assert.equal(await retrieveMemuMemory("query", { enabled: true, binary: "/nonexistent/memu", logger: { warn() {} } }), "");
});
