import fs from "node:fs/promises";
import path from "node:path";
import { buildScopedRecallQuery } from "../../memory/scoped-recall.mjs";
import { isCheckpointExpired } from "../../memory/active-task-memory.mjs";
import { verifiedRecoveryPreamble } from "../../memory/verified-recovery.mjs";
import { approvedFactoryBrainDigest, loadFactoryBrain } from "../../memory/factory-brain.mjs";

/**
 * Prepare a Linux-local task before any agent is launched. The bridge injects
 * the same durable ledger, memory adapters, and prompt extractors.
 */
export async function prepareLocalAgentTask({
  job, route, agent, jobKey, safeJobId, jobStore,
  activeTaskMemory, drainProgressWrites, retrieveMemuMemory,
  extractDirectTask, extractPromptContext, logger = console,
  loadVerifiedMemoryReference = null,
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
    const originalTask = extractDirectTask(extractPromptContext(job));
    // The legacy store is keyed by repository+issue and is not independently
    // agent/tenant isolated. Inject only checkpoints with verified prior scope.
    const requestedScope = {
      tenantId: job.organizationId,
      agentId: agent,
      repositoryRoot: route.repositoryRoot,
      issueId,
    };
    // This is a deterministic query from authorized route and issue fields,
    // never reconstructed from raw issue description, model text or MCP output.
    const recallQuery = buildScopedRecallQuery({
      repositoryId: route.repositoryRoot, issueId, taskKind: "coding",
    });
    const longTermMemory = recallQuery ? await retrieveMemuMemory(recallQuery, {
      scope: {
        agentId: agent, repositoryId: route.repositoryRoot, issueId,
        ...(job.organizationId ? { tenantId: job.organizationId } : {}),
      },
    }) : "";
    // Never put untrusted recalled text into a coding agent's instruction stream.
    if (longTermMemory) logger.log("[memU recall] retrieved context withheld from agent prompt");
    // Read, verify and update under the checkpoint store's exclusive lock.
    // An earlier read + CAS could race with progress emitted during memU
    // retrieval, after job admission had already claimed the delivery.
    let recovery = "";
    await activeTaskMemory.update(route.repositoryRoot, issueId, priorTask => {
      recovery = verifiedRecoveryPreamble(priorTask, requestedScope);
      const sameScope = priorTask?.tenantId === requestedScope.tenantId &&
        priorTask?.agentId === requestedScope.agentId &&
        priorTask?.repositoryRoot === requestedScope.repositoryRoot &&
        priorTask?.issueId === requestedScope.issueId &&
        typeof requestedScope.tenantId === "string" && requestedScope.tenantId.length > 0;
      return {
        expectedRevision: priorTask?.revision ?? 0,
        state: "active", lastJobKey: jobKey, lastAgent: agent,
        tenantId: job.organizationId || null, agentId: agent,
        lastWorkspace: workspace,
        lastSessionId: job.agentSessionId || job.payload?.data?.agentSessionId || null,
        lastSeenAt: new Date().toISOString(),
        // Repo+issue storage is shared. Never carry stale session-derived
        // fields into another owner's job or a newly renewed checkpoint.
        ...(!sameScope || isCheckpointExpired(priorTask) ? {
          progress: [], lastProgressAt: null, lastVerifiedResult: null,
          nextAction: null, artifacts: [], promotion: null, source: null,
          lastProviderSessionId: null, expiresAt: null,
        } : {}),
      };
    });
    // Operator-pinned, private, reviewed lower-trust reference context. An
    // absent approval or unavailable file does not affect task admission.
    const brainScope = { tenantId: job.organizationId, agentId: agent,
      repositoryRoot: route.repositoryRoot };
    const approvedDigest = approvedFactoryBrainDigest(brainScope,
      process.env.FACTORY_BRAIN_APPROVALS_JSON || "");
    const factoryBrain = await loadFactoryBrain({ ...brainScope, approvedDigest });
    // Optional M13 host-mediated signed memory references, never unscoped
    // memU CLI results. Failure only omits the reference, not the job.
    let verifiedMemoryReference = "";
    if (typeof loadVerifiedMemoryReference === "function") {
      try {
        verifiedMemoryReference = await loadVerifiedMemoryReference({
          tenantId: requestedScope.tenantId,agentId:agent,
          repositoryRoot:route.repositoryRoot,issueId,jobKey,
        });
        if (typeof verifiedMemoryReference !== "string" ||
            verifiedMemoryReference.length > 3000) verifiedMemoryReference = "";
      } catch {
        logger.warn?.("[verified memory] reference unavailable");
      }
    }
    const directTask = [factoryBrain, recovery, verifiedMemoryReference, originalTask]
      .filter(Boolean).join("\n\n");
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
