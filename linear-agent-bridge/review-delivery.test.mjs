import test from "node:test";
import assert from "node:assert/strict";
import { verifyPublishedGithubReview } from "./review-delivery.mjs";
import { createReviewInbox } from "./review-inbox.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sha = "a".repeat(40);
const record = { repository: "REVREBEL/linear-agents", number: 51, headSha: sha };
function githubFetch({ reviewState = "COMMENTED", headSha = sha, reviewSha = sha,
  reviewer = "revrebel-chatgpt", submitted = "2026-11-09T12:00:00Z" } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const isReview = /\/reviews\/123$/.test(url);
    const data = isReview
      ? { id: 123, state: reviewState, submitted_at: submitted, user: { login: reviewer },
          commit_id: reviewSha, html_url: "https://github.com/REVREBEL/linear-agents/pull/51#pullrequestreview-123" }
      : { number: 51, base: { repo: { full_name: record.repository } }, head: { sha: headSha } };
    return { ok: true, json: async () => data };
  };
  return { fetchImpl, calls };
}
test("published exact-head GitHub review produces verified evidence", async () => {
  const remote = githubFetch();
  const result = await verifyPublishedGithubReview(record, { githubReviewId: 123 }, {
    token: "test-token", reviewerLogin: "revrebel-chatgpt", fetchImpl: remote.fetchImpl,
  });
  assert.equal(result.githubReviewId, 123);
  assert.equal(result.githubReviewState, "COMMENTED");
  assert.equal(result.githubReviewedCommit, sha);
  assert.equal(remote.calls.length, 2);
});
test("rejects stale PR, mismatched author, missing submission, and nonpublished states", async () => {
  for (const opts of [
    { headSha: "b".repeat(40) }, { reviewSha: "b".repeat(40) },
    { reviewer: "another-account" }, { submitted: null },
    { reviewState: "PENDING" }, { reviewState: "DISMISSED" },
  ]) {
    await assert.rejects(verifyPublishedGithubReview(record, { githubReviewId: 123 }, {
      token: "test-token", reviewerLogin: "revrebel-chatgpt",
      fetchImpl: githubFetch(opts).fetchImpl,
    }));
  }
});
test("cannot mark a task reviewed without publication evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linear-review-delivery-"));
  try {
    const inbox = createReviewInbox(dir);
    const event = { repository: "REVREBEL/linear-agents", number: 51, headSha: sha,
      event: "pull_request", action: "ready_for_review", url: "https://github.com/REVREBEL/linear-agents/pull/51" };
    const { record: task } = await inbox.enqueue(event, {
      source: "chatgpt", destination: { ok: true, projectIds: ["project"],
        conversationUrl: "https://chatgpt.com/c/test" },
    });
    await inbox.claim(task.reviewId, "chatgpt-user");
    await assert.rejects(inbox.finish(task.reviewId, { status: "reviewed", summary: "Done" }),
      /evidence/);
    const finished = await inbox.finish(task.reviewId, {
      status: "reviewed", summary: "Published", delivery: {
        githubReviewId: 123, githubReviewedCommit: sha, verifiedAt: new Date().toISOString(),
      },
    });
    assert.equal(finished.delivery.githubReviewId, 123);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
