import crypto from "node:crypto";
import {
  hashRemoteToken,
  validateActivityEndpoint,
  validateTraeCompletionUrl,
} from "../routing/remote-trae-activity.mjs";
import { launchMacTrae } from "../routing/ssh-dispatch.mjs";

/**
 * Process an already authenticated, admitted macOS job without writing an
 * HTTP response. Ubuntu keeps the durable ledger and the Mac validates its
 * own filesystem. No other remote provider is supported yet.
 */
export async function coordinateRemoteExecution({
  agent, job, jobKey, safeJobId, credential, host, route,
  jobStore, osxProjectsRoot,
  extractPromptContext, extractDirectTask, extractAgentSessionId,
  env = process.env,
  generateToken = () => crypto.randomBytes(32).toString("hex"),
  dispatch = launchMacTrae,
}) {
  if (agent !== "trae") {
    await jobStore.transition(jobKey, "unrouted", {
      error: "Mac SSH runner currently supports Trae only",
    });
    return { status: 422, body: { ok: false, accepted: false,
      error: "Mac SSH runner currently supports Trae only" } };
  }
  const promptContext = extractDirectTask(extractPromptContext(job));
  if (!promptContext || !credential?.accessToken) {
    await jobStore.transition(jobKey, "failed", { error: "Missing Mac Trae prompt or app credential" });
    return { status: 422, body: { ok: false, accepted: false,
      error: "Missing remote prompt or credential" } };
  }

  const sessionId = extractAgentSessionId(job);
  const remoteActivityToken = generateToken();
  const completionHost = env.TRAE_WORKER_HOST ||
    `linear-${env.TRAE_PREFIX || "trae"}.${env.DOMAIN || "revrebel.io"}`;
  const rawCompletionUrl = job.completionUrl || job.payload?.data?.completionUrl;
  const remoteCompletionUrl = rawCompletionUrl
    ? validateTraeCompletionUrl(rawCompletionUrl, completionHost) : null;
  if (!sessionId || !remoteCompletionUrl) {
    await jobStore.transition(jobKey, "failed", { error: "Missing Mac Trae session or completion URL" });
    return { status: 422, body: { ok: false, accepted: false,
      error: "Missing Mac Trae callback context" } };
  }

  const activityHost = env.TRAE_HOST || "trae-agent.revrebel.io";
  const activityEndpoint = validateActivityEndpoint(
    env.MAC_TRAE_ACTIVITY_URL || `https://${activityHost}/trae-activity`,
    activityHost,
  );
  const message = {
    agent: "trae", jobId: safeJobId,
    projectId: route.scopeKey, repository: route.repository,
    projectsRoot: osxProjectsRoot,
    projectScope: route.projectScope, launchFromScope: route.launchFromScope,
    prompt: promptContext, agentSessionId: sessionId,
    activityEndpoint, completionEndpoint: validateActivityEndpoint(
      activityEndpoint.replace("/trae-activity", "/trae-complete"), activityHost, "/trae-complete",
    ), activityToken: remoteActivityToken, jobKey,
    accessToken: credential.accessToken,
    traeBin: env.MAC_TRAE_BIN || "trae",
    githubAppName: env.TRAE_GITHUB_APP_NAME || "revrebel-trae",
    githubAppId: env.TRAE_GITHUB_APP_ID || "5660644",
    job: {
      routing: job.routing, issueId: job.issueId || job.issueMetadata?.id,
      issueMetadata: job.issueMetadata, source: job.source,
      sessionAction: job.sessionAction, agentSessionId: sessionId,
      completionUrl: job.completionUrl,
      payload: { data: { promptContext, agentSessionId: sessionId, completionUrl: job.completionUrl } },
    },
  };
  // Commit the capability hash and the remote callback URL before SSH
  // dispatch so no remote activity is accepted without durable authorization.
  await jobStore.transition(jobKey, "launching", {
    executionHost: "macos", repository: route.repository,
    workspace: route.launchDirectory, agentSessionId: sessionId,
    issueId: message.job.issueId || null, attempts: 1,
    remoteTask: { jobId: safeJobId, repository: route.repository, projectId: route.scopeKey },
    remoteActivityTokenHash: hashRemoteToken(remoteActivityToken),
    remoteCompletionUrl,
  });
  try {
    await dispatch({ job: message, jobKey, jobStore });
  } catch (error) {
    await jobStore.transition(jobKey, "failed", { error: String(error), executionHost: "macos" });
    return { status: 503, body: { ok: false, accepted: false,
      error: "Mac Trae dispatch failed; reconcile remote job state before retry" } };
  }
  return { status: 202, body: { ok: true, accepted: true,
    jobId: safeJobId, executionHost: "macos", host } };
}
