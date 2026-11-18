/**
 * Mirror verified job-ledger transitions into issue-scoped recovery memory.
 * Ledger state remains authoritative; this is best-effort context, not a job scheduler.
 */
const STATES = {
  queued: ["pending", "Job queued; inspect the durable job ledger before retrying"],
  launching: ["active", "Launch requested; verify process and ledger before retrying"],
  running: ["active", "Agent was running; verify its session and workspace before resuming"],
  waiting_quota: ["needs-recovery", "Quota wait; inspect the ledger retry schedule before resuming"],
  awaiting_external: ["needs-recovery", "Awaiting external confirmation; do not assume completion"],
  failed: ["needs-recovery", "Execution failed; inspect ledger and workspace before retrying"],
  completed: ["agent-finished", "Agent process completed; verify tests, artifacts, and Linear callback"],
};

export async function mirrorAgentTransition({ memory, jobStore, jobKey, state, agent, logger = console }) {
  const mapping = STATES[state];
  if (!mapping) return false;
  try {
    const job = await jobStore.get(jobKey);
    if (!job?.repositoryRoot || !job?.issueId) return false;
    const current = await memory.read(job.repositoryRoot, job.issueId);
    // A late callback from an older session must not overwrite newer recovery state.
    if (current?.lastJobKey !== jobKey) return false;
    await memory.update(job.repositoryRoot, job.issueId, prior => {
      if (prior?.lastJobKey !== jobKey) return { expectedRevision: -1 }; // fail closed under lock
      return {
        expectedRevision: prior.revision,
        state: mapping[0],
        nextAction: mapping[1],
        lastAgent: agent,
        lastSeenAt: new Date().toISOString(),
        ...(state === "completed" ? { lastVerifiedResult: "Ledger reports completion; task result not independently verified" } : {}),
        ...(state === "failed" ? { lastVerifiedResult: "Ledger reports failure; recovery required" } : {}),
      };
    });
    return true;
  } catch (error) {
    if (error.code !== "ECONFLICT") logger.warn?.(`Checkpoint mirror unavailable: ${error.message}`);
    return false;
  }
}

export function withLocalAgentCheckpoint({ jobStore, memory, jobKey, agent, logger = console }) {
  return new Proxy(jobStore, {
    get(target, property) {
      if (property !== "transition") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (key, state, metadata) => {
        const record = await target.transition(key, state, metadata);
        if (key === jobKey) await mirrorAgentTransition({ memory, jobStore: target, jobKey, state, agent, logger });
        return record;
      };
    },
  });
}
