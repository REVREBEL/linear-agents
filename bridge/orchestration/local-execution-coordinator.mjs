import { withLocalAgentCheckpoint } from "../../memory/local-agent-checkpoint.mjs";
import { prepareLocalAgentTask } from "../../jobs/preparation/local-task-preparation.mjs";
import { dispatchMockAgent, dispatchGemmaAgent } from "../../jobs/dispatch/simple-agent-dispatch.mjs";
import { dispatchAntigravityAgent } from "../../jobs/dispatch/antigravity-dispatch.mjs";
import { dispatchChatgptCliAgent } from "../../jobs/dispatch/chatgpt-cli-dispatch.mjs";
import { dispatchChatgptHumanHandoff } from "../../jobs/dispatch/chatgpt-human-handoff.mjs";
import { dispatchLocalTraeAgent } from "../../jobs/dispatch/trae-local-dispatch.mjs";
import { dispatchGeminiAgent } from "../../jobs/dispatch/gemini-dispatch.mjs";

/**
 * Run a previously admitted Linux-local job, without owning HTTP responses.
 * Preparing the task and its durable ledger transition must precede launch.
 * Trae alone owns its launching transition inside dispatchLocalTraeAgent so
 * its private callback capability is committed before spawning the process.
 * The other launch adapters retain their original await / fire-and-forget
 * semantics, including the original unknown-agent 202 response behavior.
 */
export async function coordinateLocalExecution({
  job, route, agent, jobKey, safeJobId, credential, host,
  jobStore, activeTaskMemory, drainProgressWrites, retrieveMemuMemory,
  extractDirectTask, extractPromptContext, extractAgentSessionId,
  agySessionQueue, readAgyProjectConversation, saveAgyProjectConversation,
  recordResumedConversation, startAntigravity,
  enqueueChatgptHandoff, startChatgptOpenCode, projectDir,
  traeBin, traeArgsTemplate, buildGenericArgs, maskArg, attachProcessLogs,
  startGemma, geminiBin, geminiLaunchMode, geminiArgsTemplate,
  startGeminiInWarp, buildGeminiLaunch, spawnProcess,
  logger = console, managedSubmission = null,
  prepareTask = prepareLocalAgentTask,
  dispatchers = {
    mock: dispatchMockAgent,
    antigravity: dispatchAntigravityAgent,
    chatgptCli: dispatchChatgptCliAgent,
    chatgptHuman: dispatchChatgptHumanHandoff,
    trae: dispatchLocalTraeAgent,
    gemma: dispatchGemmaAgent,
    gemini: dispatchGeminiAgent,
  },
}) {
  const { workspace, filename, routedJob } = await prepareTask({
    job, route, agent, jobKey, safeJobId, jobStore,
    activeTaskMemory, drainProgressWrites, retrieveMemuMemory,
    extractDirectTask, extractPromptContext,
  });
  jobStore = withLocalAgentCheckpoint({ jobStore, memory: activeTaskMemory, jobKey, agent, logger });
  logger.log("\nLinear job received");
  logger.log(`Host: ${host}`);
  logger.log(`Saved to: ${filename}`);
  logger.log(`Resolved workspace: ${workspace}`);
  logger.log(`Project scope: ${route.projectScope}`);

  if (managedSubmission) {
    // Managed dispatch is mutually exclusive with legacy callbacks and
    // credential-bearing provider launchers. Await durable launch acceptance.
    await managedSubmission.dispatch({agent, job:routedJob, route, jobKey, workspace, filename,
      prompt:extractPromptContext(routedJob)});
    return {status:202,body:{ok:true,accepted:true,jobId:safeJobId,host}};
  }

  if (agent !== "trae") await jobStore.transition(jobKey, "launching", { attempts: 1 });
  if (agent === "mock") {
    await dispatchers.mock({ jobStore, jobKey, filename });
  } else if (agent === "antigravity") {
    dispatchers.antigravity({
      job: routedJob, route, filename, workspace, jobKey, credential,
      agySessionQueue, extractAgentSessionId, readAgyProjectConversation,
      saveAgyProjectConversation, recordResumedConversation, startAntigravity,
      jobStore,
    });
  } else if (agent === "chatgpt-cli") {
    dispatchers.chatgptCli({
      job: routedJob, workspace, jobKey, credential,
      enqueueChatgptHandoff, startChatgptOpenCode, jobStore,
    });
  } else if (agent === "chatgpt") {
    await dispatchers.chatgptHuman({
      route, job: routedJob, filename, safeJobId, jobKey,
      jobStore, extractPromptContext, enqueueChatgptHandoff,
      projectDir,
    });
  } else if (agent === "trae") {
    await dispatchers.trae({
      job: routedJob, filename, workspace, jobKey, credential,
      repositoryRoot: route.repositoryRoot, traeBin,
      traeArgsTemplate, jobStore,
      extractPromptContext, extractAgentSessionId,
      buildGenericArgs, maskArg, attachProcessLogs,
    });
  } else if (agent === "gemma") {
    dispatchers.gemma({
      job: routedJob, workspace, jobKey, credential, startGemma, jobStore,
    });
  } else if (agent === "gemini") {
    await dispatchers.gemini({
      job: routedJob, filename, workspace, jobKey, credential,
      geminiBin, geminiLaunchMode, geminiArgsTemplate,
      jobStore, extractPromptContext, startGeminiInWarp,
      buildGeminiLaunch, buildGenericArgs, maskArg, attachProcessLogs,
      spawnProcess,
    });
  } else {
    await jobStore.transition(jobKey, "failed", { error: "Unknown agent host" });
    logger.log(`Unknown agent hostname: ${host}. Job saved but not executed.`);
  }

  return { status: 202, body: { ok: true, accepted: true, jobId: safeJobId, host } };
}
