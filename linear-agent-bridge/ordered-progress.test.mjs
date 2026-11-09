import test from "node:test";
import assert from "node:assert/strict";
import { createOrderedProgressQueue } from "./ordered-progress.mjs";

test("rapid progress events persist in source order regardless of asynchronous delays", async () => {
  const q = createOrderedProgressQueue();
  const saved = [];
  const writes = Array.from({ length: 12 }, (_, index) => q.enqueue(async () => {
    await new Promise(resolve => setTimeout(resolve, index % 3 === 0 ? 5 : 0));
    saved.push(index);
  }));
  await q.drain();
  await Promise.all(writes);
  assert.deepEqual(saved, Array.from({ length: 12 }, (_, index) => index));
});
test("one failed progress write does not block later checkpoints", async () => {
  const q = createOrderedProgressQueue();
  const first = q.enqueue(async () => { throw Error("disk unavailable"); });
  const saved = [];
  const second = q.enqueue(async () => { saved.push("later"); });
  await assert.rejects(first, /disk unavailable/);
  await second;
  await q.drain();
  assert.deepEqual(saved, ["later"]);
});
