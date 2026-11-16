/**
 * Serialize Antigravity execution by agent session or shared project
 * conversation, and recover only verified conversation IDs.
 *
 * The main bridge owns the queue, job ledger, conversation persistence,
 * credential and actual Antigravity launcher. This adapter preserves
 * asynchronous queue dispatch without waiting for execution in /jobs.
 */
export function dispatchAntigravityAgent({
  job: routedJob, route, filename, workspace, jobKey, credential,
  agySessionQueue, extractAgentSessionId, readAgyProjectConversation,
  saveAgyProjectConversation, recordResumedConversation, startAntigravity,
  jobStore, issueRecoveryEnabled = process.env.ANTIGRAVITY_ISSUE_RECOVERY_ENABLED === "true",
  logger = console,
}) {
  const sessionId = extractAgentSessionId(routedJob);
  // Shared project conversations must not receive concurrent invocations.
  const projectConversationQueueKey = route.agyConversationMode === "reuse-existing"
    ? "project:" + route.projectId : sessionId;
  void agySessionQueue.enqueue(projectConversationQueueKey, async () => {
    let conversationId = route.agyConversationId || null;
    let conversationSource = conversationId ? "project_reuse" : "follow_up";
    if (route.agyConversationMode === "reuse-existing" && !conversationId) {
      conversationId = await readAgyProjectConversation(route.projectId, workspace);
      if (conversationId) conversationSource = "project_reuse";
    }
    if (!conversationId && route.agyConversationMode !== "reuse-existing" && routedJob.sessionAction === "prompted") {
      const prior = await jobStore.findLatestConversationBySessionId(sessionId, jobKey, workspace);
      conversationId = prior?.conversationId || null;
    }
    // Cross-session recovery is opt-in and never supersedes same-session continuity.
    if (!conversationId && route.agyConversationMode !== "reuse-existing" &&
        routedJob.sessionAction !== "prompted" && issueRecoveryEnabled) {
      const issueId = routedJob.issueMetadata?.id || routedJob.issueId || null;
      const prior = await jobStore.findLatestCompletedConversationByIssueId(issueId, sessionId, workspace, jobKey);
      if (prior) {
        conversationId = prior.conversationId;
        conversationSource = "issue_recovery";
        await jobStore.transition(jobKey, "launching", {
          recoveredFromAgentSessionId: prior.agentSessionId,
          recoveredFromJobKey: prior.key,
        });
      }
    }
    await recordResumedConversation(jobStore, jobKey, conversationId, conversationSource);
    const actualConversationId = await startAntigravity(
      routedJob, filename, workspace, jobKey, conversationId,
      route.agyConversationMode === "reuse-existing"
        ? async id => saveAgyProjectConversation(route.projectId, workspace, id)
        : null, credential
    );
    if (route.agyConversationMode === "reuse-existing" && actualConversationId) {
      await saveAgyProjectConversation(route.projectId, workspace, actualConversationId);
      logger.log(`[Antigravity] Project ${route.projectId} conversation: ${actualConversationId}`);
    } else if (route.agyConversationMode === "reuse-existing") {
      logger.warn(`[Antigravity] Project ${route.projectId}: no verified conversation ID; next delivery will start fresh`);
    }
  }).catch(async error => {
    logger.error("AGY queued execution failed:", error);
    await jobStore.transition(jobKey, "failed", { error: String(error) }).catch(logger.error);
  });
}
