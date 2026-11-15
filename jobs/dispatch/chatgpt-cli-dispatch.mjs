/**
 * Enqueue ChatGPT CLI execution through the existing serialized handoff queue.
 * This is the coding-agent identity, not the human ChatGPT review inbox.
 * The bridge owns the queue, OpenCode runner and durable job store.
 */
export function dispatchChatgptCliAgent({
  job, workspace, jobKey, credential,
  enqueueChatgptHandoff, startChatgptOpenCode, jobStore,
  logger = console,
}) {
  void enqueueChatgptHandoff(() =>
    startChatgptOpenCode(job, workspace, jobKey, credential)
  ).catch(async error => {
    logger.error("ChatGPT CLI execution failed:", error.message);
    await jobStore.transition(jobKey, "failed", { error: String(error) })
      .catch(logger.error);
  });
}
