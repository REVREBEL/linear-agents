// Serialize AGY processes for one Linear session without blocking other sessions.
export function createSessionQueue() {
  const tails = new Map();
  return {
    enqueue(sessionId, task) {
      if (!sessionId) return Promise.reject(new Error("Missing Linear Agent Session ID"));
      const prior = tails.get(sessionId) || Promise.resolve();
      const run = prior.catch(() => {}).then(task);
      const tail = run.catch(() => {});
      tails.set(sessionId, tail);
      void tail.finally(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
      return run;
    },
  };
}
