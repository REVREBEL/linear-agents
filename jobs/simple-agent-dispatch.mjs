/**
 * Lightweight launch adapters for the Mock and Gemma agents.
 * The bridge continues to own the durable job store and the actual
 * isolated Gemma runner; no task execution or state is moved here.
 */
export async function dispatchMockAgent({ jobStore, jobKey, filename, logger = console }) {
  await jobStore.transition(jobKey, "awaiting_external", {
    note: "Mock Agent queued; use mock-agent CLI to advance status or comment",
    taskFile: filename,
  });
  logger.log(`Mock Agent queued: ${filename}`);
}

/**
 * Preserve fire-and-forget Gemma admission. Failed asynchronous launch
 * is recorded on the durable ledger without changing the HTTP 202 ACK.
 * The returned promise is not awaited by the ingress route.
 */
export function dispatchGemmaAgent({
  job, workspace, jobKey, credential, startGemma, jobStore, logger = console,
}) {
  void startGemma(job, workspace, jobKey, credential).catch(async error => {
    logger.error("Gemma execution failed:", error.message);
    await jobStore.transition(jobKey, "failed", { error: "Gemma execution failure" })
      .catch(logger.error);
  });
}
