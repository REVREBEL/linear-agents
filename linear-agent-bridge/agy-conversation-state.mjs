/**
 * Record the conversation being resumed before AGY is launched.
 * The inherited verification timestamp belongs to the original observation;
 * this follow-up is a resume, not an independently verified new conversation.
 */
export async function recordResumedConversation(store, jobKey, conversationId, source = "follow_up") {
  if (!conversationId) return null;
  return store.transition(jobKey, "launching", {
    conversationId,
    resumedConversationId: conversationId,
    conversationSource: source,
    resumeRequestedAt: new Date().toISOString(),
  });
}
