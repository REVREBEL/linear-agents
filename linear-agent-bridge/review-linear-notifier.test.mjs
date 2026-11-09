import test from "node:test";
import assert from "node:assert/strict";
import { notifyLinearReview, reviewLinearIssueId, reviewIssueInput } from "./review-linear-notifier.mjs";

const record = { reviewId: "c".repeat(64), repository: "REVREBEL/linear-agents",
  number: 51, prUrl: "https://github.com/REVREBEL/linear-agents/pull/51",
  reason: "synchronize", headSha: "a".repeat(40), revisionUrl: null };
const teamId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

test("review notifications use stable PR-level UUID, never coding agent identity", () => {
  const id = reviewLinearIssueId(record.repository, record.number);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(reviewLinearIssueId(record.repository, record.number), id);
  assert.notEqual(reviewLinearIssueId(record.repository, 52), id);
  const input = reviewIssueInput(record, { teamId, userId });
  assert.equal(input.assigneeId, userId);
  assert.match(input.description, /NOT an assignment to the ChatGPT CLI coding agent/);
  assert.match(input.description, /github.com\/REVREBEL\/linear-agents\/pull\/51/);
});

test("review notifier creates issue assigned to the configured ChatGPT user", async () => {
  const requests = [];
  const response = await notifyLinearReview(record, {
    apiKey: "test", teamId, userId,
    fetchImpl: async (_url, request) => {
      const data = JSON.parse(request.body);
      requests.push(data);
      return { ok: true, json: async () => requests.length === 1
        ? { data: { issue: null } }
        : { data: { issueCreate: { success: true, issue: { id: data.variables.input.id, identifier: "REV-101" } } } } };
    },
  });
  assert.deepEqual(response, { created: true, identifier: "REV-101" });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].variables.input.assigneeId, userId);
});

test("subsequent review changes update the same user's review issue", async () => {
  const requests = [];
  const response = await notifyLinearReview(record, {
    apiKey: "test", teamId, userId,
    fetchImpl: async (_url, request) => {
      const data = JSON.parse(request.body);
      requests.push(data);
      return { ok: true, json: async () => requests.length === 1
        ? { data: { issue: { id: reviewLinearIssueId(record.repository, record.number), identifier: "REV-101" } } }
        : { data: { issueUpdate: { success: true, issue: { identifier: "REV-101" } } } } };
    },
  });
  assert.deepEqual(response, { created: false, identifier: "REV-101" });
  assert.equal(requests[1].variables.id, reviewLinearIssueId(record.repository, record.number));
});
test("review notifier refuses missing user/team instead of assigning to CLI agent", async () => {
  await assert.rejects(() => notifyLinearReview(record, { apiKey: "test", teamId, userId: "" }), /valid Linear team and user/);
});
