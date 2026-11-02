import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeGithubEvent, recordGithubEvent } from "./github-events.mjs";
const base = { event: "pull_request", delivery: "c0ffee00-abcd-4567-abcd-111111111111",
  payload: { action: "opened", repository: { full_name: "REVREBEL/example" },
    pull_request: { number: 12, html_url: "https://github.com/REVREBEL/example/pull/12",
      head: { sha: "a".repeat(40) }, draft: false }, installation: { id: 123 } } };
test("sanitizes webhook payload to reviewed metadata", () => {
  const record = sanitizeGithubEvent({ ...base, payload: { ...base.payload, secret: "should-never-persist" } });
  assert.equal(record.url, base.payload.pull_request.html_url);
  assert.equal(JSON.stringify(record).includes("should-never-persist"), false);
});
test("rejects mismatched PR links", () => {
  assert.throws(() => sanitizeGithubEvent({ ...base, payload: { ...base.payload, pull_request: { ...base.payload.pull_request, html_url: "https://evil.example/pull/12" } } }));
});
test("journals sanitized event", async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(),"github-events-test-"));
 try {
  await recordGithubEvent(dir, sanitizeGithubEvent(base), "chatgpt");
  const lines = (await readFile(path.join(dir,"github-events","events.jsonl"),"utf8")).trim().split("\n");
  assert.equal(lines.length,1);
  assert.equal(JSON.parse(lines[0]).number,12);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
