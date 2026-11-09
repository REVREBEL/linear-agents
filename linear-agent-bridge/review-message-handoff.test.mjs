import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createReviewInbox } from "./review-inbox.mjs";
import { reviewSshArgs, sendInitialReviewMessage } from "./review-message-handoff.mjs";

const reviewId = "a".repeat(64);
const record = {
  reviewId,
  conversationUrl: "https://chatgpt.com/g/g-p-project/c/review-conversation",
  prompt: "Review REVREBEL/linear-agents PR #51 using existing tools",
};
const env = {
  MAC_SSH_HOST: "macos",
  MAC_NODE_BIN: "/usr/local/bin/node",
  OSX_PROJECTS_ROOT: "/Users/reviewer/github-revrebel",
};

function simulatedSsh({ exitCode = 0, acknowledge = true } = {}) {
  const requests = [];
  const spawnImpl = (command, args) => {
    assert.equal(command, "ssh");
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let input = "";
    child.stdin.on("data", data => { input += data; });
    child.stdin.on("finish", () => {
      const payload = JSON.parse(input);
      requests.push(payload);
      queueMicrotask(() => {
        if (acknowledge) child.stdout.write("HANDOFF_ATTEMPTED:" + payload.reviewId + "\n");
        child.emit("close", exitCode);
      });
    });
    return child;
  };
  return { spawnImpl, requests };
}

test("Mac SSH uses fixed runner, no untrusted shell arguments", () => {
  const args = reviewSshArgs(env);
  assert.equal(args[args.length - 2], "macos");
  assert.match(args.at(-1), /review-handoff\.mjs/);
  assert.throws(() => reviewSshArgs({ ...env, MAC_SSH_HOST: "-oProxyCommand=evil" }));
  assert.throws(() => reviewSshArgs({ ...env, MAC_REVIEW_RUNNER_PATH: "/tmp/x';evil" }));
});
test("ChatGPT review submission attempt sends only prompt and destination over SSH", async () => {
  const ssh = simulatedSsh();
  const result = await sendInitialReviewMessage(record, { env, spawnImpl: ssh.spawnImpl });
  assert.equal(result.attempted, true);
  assert.deepEqual(ssh.requests, [{
    reviewId, conversationUrl: record.conversationUrl, prompt: record.prompt,
  }]);
});
test("missing SSH acknowledgment cannot masquerade as attempted delivery", async () => {
  const ssh = simulatedSsh({ acknowledge: false });
  await assert.rejects(sendInitialReviewMessage(record, { env, spawnImpl: ssh.spawnImpl }), /not acknowledged/);
});
test("durable message claims suppress double-submission, without claiming reviewed state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "review-message-claim-"));
  try {
    const inbox = createReviewInbox(dir);
    const event = { repository: "REVREBEL/linear-agents", number: 51, headSha: "b".repeat(40),
      event: "pull_request", action: "ready_for_review", url: "https://github.com/REVREBEL/linear-agents/pull/51" };
    const saved = await inbox.enqueue(event, { source: "chatgpt", destination: {
      ok: true, projectIds: ["project"], conversationUrl: record.conversationUrl,
    } });
    const [first, second] = await Promise.all([
      inbox.beginMessageHandoff(saved.record.reviewId),
      inbox.beginMessageHandoff(saved.record.reviewId),
    ]);
    assert.equal([first.started, second.started].filter(Boolean).length, 1);
    const attempted = await inbox.finishMessageHandoff(saved.record.reviewId, { attempted: true });
    assert.equal(attempted.state, "pending");
    assert.equal(attempted.messageHandoff.state, "attempted");
    const again = await inbox.beginMessageHandoff(saved.record.reviewId);
    assert.equal(again.started, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
