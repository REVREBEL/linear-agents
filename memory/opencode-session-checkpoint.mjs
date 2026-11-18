/**
 * Provider-specific OpenCode session and progress observations for the
 * issue-scoped short-term checkpoint. The job ledger remains authoritative.
 */
export async function updateOpenCodeCheckpoint({ jobStore, memory, jobKey, patch, logger = console }) {
  try {
    const job = await jobStore.get(jobKey);
    if (!job?.repositoryRoot || !job?.issueId) return false;
    await memory.update(job.repositoryRoot, job.issueId, prior => {
      if (prior?.lastJobKey !== jobKey) return { expectedRevision: -1 };
      return { expectedRevision: prior.revision, ...patch };
    });
    return true;
  } catch (error) {
    if (error.code !== "ECONFLICT") logger.warn?.(`[OpenCode checkpoint] ${error.message}`);
    return false;
  }
}

export async function recordOpenCodeProgress({ jobStore, memory, jobKey, summary, logger = console }) {
  try {
    const job = await jobStore.get(jobKey);
    if (!job?.repositoryRoot || !job?.issueId) return false;
    const result = await memory.progress(job.repositoryRoot, job.issueId, {
      kind: "tool", summary, jobKey,
    });
    return Boolean(result);
  } catch (error) {
    if (error.code !== "ECONFLICT") logger.warn?.(`[OpenCode progress] ${error.message}`);
    return false;
  }
}
