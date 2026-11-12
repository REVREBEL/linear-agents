/**
 * Preserve the order of tool milestones within one agent process even when
 * asynchronous job metadata lookups resolve at different speeds.
 */
export function createOrderedProgressQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(task) {
      const next = tail.then(task);
      // Keep the queue usable after a failed operation; callers still see
      // the original failure on the returned promise.
      tail = next.catch(() => {});
      return next;
    },
    drain() { return tail; },
  };
}
