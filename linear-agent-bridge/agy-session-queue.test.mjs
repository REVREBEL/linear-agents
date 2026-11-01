import test from "node:test";
import assert from "node:assert/strict";
import { createSessionQueue } from "./agy-session-queue.mjs";

test("same session runs sequentially, other sessions remain independent", async () => {
  const queue = createSessionQueue();
  const order = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = queue.enqueue("s1", async () => { order.push("first start"); await blocked; order.push("first end"); });
  const second = queue.enqueue("s1", async () => { order.push("second"); });
  const other = queue.enqueue("s2", async () => { order.push("other"); });
  await other;
  assert.deepEqual(order, ["first start", "other"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first start", "other", "first end", "second"]);
});
test("a failed task does not block the next AGY follow-up", async () => {
  const queue = createSessionQueue();
  const first = queue.enqueue("s", async () => { throw new Error("failed"); });
  const second = queue.enqueue("s", async () => "recovered");
  await assert.rejects(first, /failed/);
  assert.equal(await second, "recovered");
});
