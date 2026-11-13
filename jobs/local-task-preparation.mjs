import fs from "node:fs/promises";
import path from "node:path";

/**
 * Prepare a Linux-local task before any agent is launched. The bridge injects
 * the same durable ledger, memory adapters, and prompt extractors.
 */
export async function prepareLocalAgentTask({
  job, route, agent, jobKey, safeJobId, jobStore,
  activeTaskMemory, drainProgressWrites, retrieveMemuMemory,
  extractDirectTask, extractPromptContext, logger = console,
}) {
    const workspace = route.launchDirectory;
    const taskDir = path.join(route.repositoryRoot, ".linear-agent", "projects", route.scopeKey, "inbox");
    await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
    // Keep runtime task payloads local without modifying the repository's tracked .gitignore.
    const localExclude = path.join(route.repositoryRoot, ".git", "info", "exclude");
    try {
      const existingExclude = await fs.readFile(localExclude, "utf8");
      if (!existingExclude.split(/\r?\n/).includes("/.linear-agent/")) {
        await fs.appendFile(localExclude, "\n/.linear-agent/\n");
      }
    } catch (error) {
      logger.warn(`Unable to set local Git exclusion for task directory: ${error.message}`);
    }
    const filename = path.join(taskDir, `${safeJobId}.json`);
    const issueId = job.issueMetadata?.id || job.issueId || null;
    await drainProgressWrites();
    const priorTask = await activeTaskMemory.read(route.repositoryRoot, issueId);
    const originalTask = extractDirectTask(extractPromptContext(job));
    const recovery = activeTaskMemory.recoveryPreamble(priorTask);
    const longTermMemory = await retrieveMemuMemory(
      "Repository: " + (route.repositoryRoot || "") + ". Coding conventions, previous failures, testing practices."
    );
    // Never put untrusted recalled text into a coding agent's instruction stream.
    if (longTermMemory) logger.log("[memU recall] retrieved context withheld from agent prompt");
    const directTask = recovery ? recovery + "\n\n" + originalTask : originalTask;
    await activeTaskMemory.update(route.repositoryRoot, issueId, {
      state: "active", lastJobKey: jobKey, lastAgent: agent,
      lastWorkspace: workspace,
      lastSessionId: job.agentSessionId || job.payload?.data?.agentSessionId || null,
      lastSeenAt: new Date().toISOString(),
    });
    // Persist and dispatch one canonical prompt. The raw Linear webhook embeds
    // the same issue in agentSession.issue and promptContext; keeping it
    // duplicates instructions and unnecessarily expands downstream context.
    const routedJob = {
      routing: job.routing,
      issueId: job.issueMetadata?.id || job.issueId || null,
      issueMetadata: job.issueMetadata,
      source: job.source,
      sessionAction: job.sessionAction || "created",
      receivedAt: job.receivedAt,
      organizationId: job.organizationId,
      agentSessionId: job.agentSessionId,
      completionUrl: job.completionUrl,
      payload: {
        data: {
          promptContext: directTask,
          agentSessionId: job.agentSessionId ?? job.payload?.data?.agentSessionId,
          completionUrl: job.completionUrl ?? job.payload?.data?.completionUrl,
        },
      },
    };
    await fs.writeFile(filename, JSON.stringify({
      ...routedJob,
      resolvedRouting: {
        repositoryRoot: route.repositoryRoot,
        projectScope: route.projectScope,
        launchDirectory: route.launchDirectory,
        linearProjectId: route.projectId,
        linearInitiativeId: route.initiativeId,
        chatgptProjectUrl: route.chatgptProjectUrl || null,
        chatgptConversationMode: route.chatgptConversationMode || null,
        chatgptAutoSend: route.chatgptAutoSend === true,
        agentRole: route.agentRole,
        codeReviewRole: route.codeReviewRole,
        agyConversationMode: route.agyConversationMode,
        agyConversationId: route.agyConversationId,
      },
    }, null, 2), { mode: 0o600 });

    await jobStore.transition(jobKey, "queued", { taskFile: filename, repositoryRoot: route.repositoryRoot, workspace, agentSessionId: job.agentSessionId || job.payload?.data?.agentSessionId, issueId: job.issueMetadata?.id || job.issueId || null });

    return { workspace, filename, routedJob };
}
