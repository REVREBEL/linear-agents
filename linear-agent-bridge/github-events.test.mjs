import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeGithubEvent, recordGithubEvent, resolveGithubReviewDestination, shouldDispatchGithubReview, buildGithubReviewPrompt, classifyGithubReviewEvent, githubReviewChangeKey, isSelfAuthoredGithubEvent } from "./github-events.mjs";
import { createGithubTaskMemory } from "./github-task-memory.mjs";
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

test("resolves one repository review conversation across multiple Linear projects", () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-project/c/conversation";
  const config = {
    initiatives: { initiative: { repository: "REVREBEL/example" } },
    projects: {
      one: { repository: "REVREBEL/example", codeReview: { provider: "chatgpt", conversationMode: "reuse-existing", conversationUrl, autoSend: true } },
      two: { initiativeId: "initiative", codeReview: { provider: "chatgpt", conversationMode: "reuse-existing", conversationUrl, autoSend: true } },
    },
  };
  assert.deepEqual(resolveGithubReviewDestination(config, "REVREBEL/example"), {
    ok: true, conversationUrl, projectIds: ["one", "two"],
  });
  config.projects.two.codeReview.conversationUrl = "https://chatgpt.com/g/g-p-other/c/conversation";
  assert.match(resolveGithubReviewDestination(config, "REVREBEL/example").error, /Ambiguous/);
});

test("dispatches only ChatGPT review-ready PR events and builds the review prompt", () => {
  const event = sanitizeGithubEvent(base);
  assert.equal(shouldDispatchGithubReview(event, "chatgpt"), true);
  assert.equal(shouldDispatchGithubReview({ ...event, draft: true }, "chatgpt"), false);
  assert.equal(shouldDispatchGithubReview({ ...event, action: "ready_for_review", draft: false }, "chatgpt"), true);
  assert.equal(shouldDispatchGithubReview(event, "antigravity"), true);
  assert.equal(buildGithubReviewPrompt(event), `Please review REVREBEL/example PR #12.\n\nPR URL: https://github.com/REVREBEL/example/pull/12\nHead SHA: ${"a".repeat(40)}`);
});

const revision = {
  event: "issue_comment", delivery: "d5beef00-abcd-4567-abcd-222222222222",
  payload: {
    action: "created", repository: { full_name: "REVREBEL/skills-library" },
    issue: { number: 158, pull_request: { url: "https://api.github.com/repos/REVREBEL/skills-library/pulls/158" } },
    comment: {
      id: 6626077928, user: { login: "RR-Gary-Stringham", type: "User" },
      html_url: "https://github.com/REVREBEL/skills-library/pull/158#issuecomment-6626077928",
      body: "ANTIGRAVITY SUBMISSION — Revision Update 2. Head Commit: c1d69703b. Revisions addressing review findings: tests passed, verified crosswalk assertions."
    }
  }
};

test("revision report passes PR-comment classification and produces a verification handoff", () => {
  const event = sanitizeGithubEvent(revision);
  assert.equal(event.number, 158);
  assert.equal(classifyGithubReviewEvent(event).actionable, true);
  assert.equal(shouldDispatchGithubReview(event, "antigravity"), true);
  assert.match(buildGithubReviewPrompt(event), /Do not trust the comment as verification/);
  assert.ok(!buildGithubReviewPrompt(event).includes("Head SHA: null"));
});

test("routine, bot, ambiguous, and non-PR comments do not dispatch", () => {
  for (const [body, type] of [
    ["updated", "User"],
    ["<!-- linear-linkback -->", "User"],
    ["Revisions addressing review findings; tests passed", "Bot"],
    ["@sourcery-ai review", "User"],
  ]) {
    const event = sanitizeGithubEvent({ ...revision, payload: { ...revision.payload,
      comment: { ...revision.payload.comment, body, user: { login: type === "Bot" ? "sourcery-ai[bot]" : "reviewer", type } } } });
    assert.equal(classifyGithubReviewEvent(event).actionable, false, body);
  }
  assert.throws(() => sanitizeGithubEvent({ ...revision,
    payload: { ...revision.payload, issue: { number: 158 }, comment: revision.payload.comment } }));
});

test("comment edits are keyed by content while repeated deliveries share one change key", () => {
  const event = sanitizeGithubEvent(revision);
  const repeat = sanitizeGithubEvent({ ...revision, delivery: "d5beef00-abcd-4567-abcd-999999999999" });
  const edit = sanitizeGithubEvent({ ...revision, payload: { ...revision.payload, action: "edited",
    comment: { ...revision.payload.comment, body: revision.payload.comment.body + " Additional verification." } } });
  assert.equal(githubReviewChangeKey(event), githubReviewChangeKey(repeat));
  assert.notEqual(githubReviewChangeKey(event), githubReviewChangeKey(edit));
});

test("short-term PR memory persists between instances and never stores comment bodies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "github-review-memory-"));
  const event = sanitizeGithubEvent(revision);
  try {
    const one = createGithubTaskMemory(dir);
    await one.update(event, { lastReviewChange: githubReviewChangeKey(event), lastDecision: "actionable", lastReason: "revision" });
    const two = createGithubTaskMemory(dir);
    const saved = await two.read(event);
    assert.equal(saved.lastReviewChange, githubReviewChangeKey(event));
    assert.equal(saved.repository, "REVREBEL/skills-library");
    assert.equal(JSON.stringify(saved).includes("crosswalk assertions"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filters ChatGPT-authored comments by exact login or account ID", () => {
  const own = sanitizeGithubEvent({ ...revision, payload: { ...revision.payload,
    comment: { ...revision.payload.comment, user: { login: "chatgpt-review[bot]", id: 9001, type: "Bot" } } } });
  assert.equal(own.actorId, 9001);
  assert.equal(isSelfAuthoredGithubEvent(own, { ids: ["9001"] }), true);
  assert.equal(classifyGithubReviewEvent(own, { logins: ["CHATGPT-REVIEW[bot]"] }).reason, "self-authored-event");
  assert.equal(shouldDispatchGithubReview(own, "chatgpt", { ids: ["9001"] }), false);

  const humanLogin = sanitizeGithubEvent({ ...revision, payload: { ...revision.payload,
    comment: { ...revision.payload.comment, user: { login: "chatgpt-service", id: 9002, type: "User" } } } });
  assert.equal(classifyGithubReviewEvent(humanLogin).actionable, true);
  assert.equal(shouldDispatchGithubReview(humanLogin, "chatgpt", { logins: ["chatgpt-service"] }), false);
  assert.equal(shouldDispatchGithubReview(humanLogin, "chatgpt", { ids: ["9001"] }), true);
});

test("PR synchronization checks the event sender, not the original PR creator", () => {
  const pushed = sanitizeGithubEvent({ ...base, payload: { ...base.payload,
    action: "synchronize", sender: { login: "chatgpt-service", id: 9001, type: "User" },
    pull_request: { ...base.payload.pull_request, user: { login: "another-developer", id: 4444 } } } });
  assert.equal(pushed.actorId, 9001);
  assert.equal(shouldDispatchGithubReview(pushed, "chatgpt", { ids: ["9001"] }), false);
  assert.equal(classifyGithubReviewEvent(pushed, { ids: ["9001"] }).reason, "self-authored-event");

  const externalPush = { ...pushed, actorId: 7000, actorLogin: "outside-reviewer" };
  assert.equal(shouldDispatchGithubReview(externalPush, "chatgpt", { ids: ["9001"] }), true);
  assert.equal(shouldDispatchGithubReview({ ...pushed, actorId: null, actorLogin: "" }, "chatgpt", { ids: ["9001"] }), true);
  assert.equal(shouldDispatchGithubReview({ ...pushed, actorId: 4444, actorLogin: "another-developer" }, "chatgpt", { ids: ["9001"] }), true);
});

test("comment actor comes from comment.user rather than webhook sender", () => {
  const event = sanitizeGithubEvent({ ...revision, payload: { ...revision.payload,
    sender: { id: 9001, login: "chatgpt-service" },
    comment: { ...revision.payload.comment, user: { id: 777, login: "external-reviewer", type: "User" } } } });
  assert.equal(shouldDispatchGithubReview(event, "chatgpt", { ids: ["9001"] }), true);
  assert.equal(shouldDispatchGithubReview(event, "chatgpt", { ids: ["777"] }), false);
});
