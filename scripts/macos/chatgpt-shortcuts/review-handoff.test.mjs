import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runReviewHandoff } from "./review-handoff.mjs";

const request = {
  reviewId: "b".repeat(64),
  conversationUrl: "https://chatgpt.com/g/g-p-project/c/review-session",
  prompt: "Review the current GitHub pull request",
};
function fakeRunner(onRun) {
  return (_command, args, options) => {
    onRun(args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
}
test("default review controller launches existing Playwright auto-send", async () => {
  const previous = process.env.CHATGPT_REVIEW_MAC_CONTROLLER;
  delete process.env.CHATGPT_REVIEW_MAC_CONTROLLER;
  try {
    let called = false;
    const output = await runReviewHandoff(request, { run: fakeRunner(args => {
      called = true;
      assert.match(args[0], /chatgpt-playwright\/handoff-test\.mjs$/);
      assert.ok(args.includes("--auto-send"));
    }) });
    assert.ok(called);
    assert.equal(output, "HANDOFF_ATTEMPTED:" + request.reviewId);
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_REVIEW_MAC_CONTROLLER;
    else process.env.CHATGPT_REVIEW_MAC_CONTROLLER = previous;
  }
});
test("Shortcuts compatibility mode cannot claim message submission", async () => {
  const previous = process.env.CHATGPT_REVIEW_MAC_CONTROLLER;
  process.env.CHATGPT_REVIEW_MAC_CONTROLLER = "shortcuts";
  try {
    const output = await runReviewHandoff(request, { run: fakeRunner(args => {
      assert.match(args[0], /chatgpt-shortcuts\/handoff\.mjs$/);
      assert.ok(!args.includes("--auto-send"));
    }) });
    assert.equal(output, "HANDOFF_PREPARED:" + request.reviewId);
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_REVIEW_MAC_CONTROLLER;
    else process.env.CHATGPT_REVIEW_MAC_CONTROLLER = previous;
  }
});
