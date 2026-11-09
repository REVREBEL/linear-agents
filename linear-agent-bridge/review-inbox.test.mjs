import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReviewInbox } from "./review-inbox.mjs";
import { sanitizeGithubEvent, githubReviewChangeKey } from "./github-events.mjs";

const event = sanitizeGithubEvent({
  event: "pull_request", delivery: "review-inbox-delivery-00001",
  payload: {
    action: "ready_for_review", repository: { full_name: "REVREBEL/linear-agents" },
    pull_request: { number: 51,
      html_url: "https://github.com/REVREBEL/linear-agents/pull/51",
      head: { sha: "c".repeat(40) }, draft: false,
    },
  },
});
const destination = { ok: true, projectIds: ["linearbridge-project"],
  conversationUrl: "https://chatgpt.com/g/g-p-project/c/review" };

test("GitHub review queue has its own role and deduplicates repeated webhooks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-"));
  try {
    const inbox = createReviewInbox(dir);
    const first = await inbox.enqueue(event, { source: "chatgpt", destination });
    assert.equal(first.created, true);
    assert.equal(first.record.role, "chatgpt-user-review");
    assert.equal(first.record.reviewId, githubReviewChangeKey(event));
    assert.ok(first.record.prompt.includes("pull/51"));
    assert.equal(first.record.state, "pending");
    assert.equal((await inbox.enqueue({ ...event, delivery: "review-inbox-delivery-00002" },
      { source: "antigravity", destination })).created, false);
    assert.equal((await inbox.list()).length, 1);
    const file = path.join(dir, "github-events", "review-inbox", first.record.reviewId + ".json");
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.ok(!(await readFile(file, "utf8")).includes("OPENAI_API_KEY"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("review claim and outcome are serialized, no CLI coding session involved", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-"));
  try {
    const inbox = createReviewInbox(dir);
    const { record } = await inbox.enqueue(event, { source: "chatgpt", destination });
    const results = await Promise.allSettled([
      inbox.claim(record.reviewId, "chatgpt-user"),
      inbox.claim(record.reviewId, "second-reviewer"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await inbox.list({ state: "claimed" })).length, 1);
    await assert.rejects(
      () => inbox.finish(record.reviewId, { status: "completed", summary: "not a permitted outcome" }),
      /Invalid review outcome/
    );
    const done = await inbox.finish(record.reviewId, {
      status: "reviewed", summary: "Reviewed PR #51. Found two blocking defects.",
      delivery: { githubReviewId: 123, githubReviewedCommit: event.headSha, verifiedAt: new Date().toISOString() },
    });
    assert.equal(done.state, "reviewed");
    assert.equal((await inbox.list()).length, 0);
    assert.equal((await inbox.list({ state: "reviewed" })).length, 1);
    await assert.rejects(() => inbox.claim(record.reviewId, "other"), /already claimed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("review queue rejects invalid routing and unsafe review IDs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-"));
  try {
    const inbox = createReviewInbox(dir);
    await assert.rejects(() => inbox.enqueue(event, { source: "chatgpt", destination: { ok: false } }), /Unroutable/);
    await assert.rejects(() => inbox.get("../secrets"), /Invalid review ID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
