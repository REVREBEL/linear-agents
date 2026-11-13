import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Launch the local Trae CLI with the same restricted environment and
 * repository-scoped activity capability used by the original bridge.
 * The parent bridge still owns the durable ledger and process lifecycle.
 */
export async function dispatchLocalTraeAgent({
  job, filename, workspace, jobKey, credential, repositoryRoot,
  traeBin, traeArgsTemplate, jobStore,
  extractPromptContext, extractAgentSessionId,
  buildGenericArgs, maskArg, attachProcessLogs,
  env = process.env, spawnProcess = spawn, logger = console,
  generateToken = () => crypto.randomBytes(32).toString("hex"),
  now = () => new Date().toISOString(),
}) {
  if (!traeBin) {
    void jobStore.transition(jobKey, "failed", { error: "TRAE_BIN not configured" }).catch(logger.error);
    logger.error("TRAE_BIN is not configured. Job saved but Trae was not started.");
    return;
  }

  const promptContext = extractPromptContext(job);
  if (!promptContext) {
    void jobStore.transition(jobKey, "failed", { error: "Missing Trae promptContext" }).catch(logger.error);
    logger.error("Trae skipped. No promptContext found.");
    return;
  }

  const args = buildGenericArgs(
    traeArgsTemplate,
    promptContext,
    filename,
    workspace,
  );

  logger.log("Trae job accepted. Spawning Trae...");
  logger.log(`Trae binary: ${traeBin}`);
  logger.log(`Trae workspace: ${workspace}`);
  logger.log(`Trae args: ${args.map(maskArg).join(" ")}`);
  logger.log("Trae prompt transport: positional chat prompt");

  const traeGithubAppName = env.TRAE_GITHUB_APP_NAME || "revrebel-trae";
  const traeGithubAppId = env.TRAE_GITHUB_APP_ID || "5660644";
  const traeGitName = `${traeGithubAppName}[bot]`;
  const traeGitEmail = `${traeGithubAppId}+${traeGithubAppName}[bot]@users.noreply.github.com`;

  const sessionId = extractAgentSessionId(job);
  const completionUrl = job.completionUrl || job.payload?.data?.completionUrl;
  if (!sessionId || !completionUrl) {
    await jobStore.transition(jobKey, "failed", { error: "Missing Trae activity session context" });
    logger.error("Trae skipped. Missing Agent Session ID or completion URL.");
    return;
  }
  const activityDir = path.join(repositoryRoot, ".linear-agent");
  const activityContextFile = path.join(activityDir, "trae-active-session.json");
  await fs.mkdir(activityDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(activityContextFile, JSON.stringify({
    token: generateToken(),
    agentSessionId: sessionId,
    completionUrl,
    workspace,
    jobKey,
    updatedAt: now(),
  }, null, 2), { mode: 0o600 });
  await jobStore.transition(jobKey, "launching", { activityContextFile });

  const traeProcess = spawnProcess(traeBin, args, {
    cwd: workspace,
    env: {
      ...env,
      LINEAR_API_KEY: "", LINEAR_ACCESS_TOKEN: "",
      [credential.variable]: credential.accessToken,
      GIT_AUTHOR_NAME: traeGitName,
      GIT_AUTHOR_EMAIL: traeGitEmail,
      GIT_COMMITTER_NAME: traeGitName,
      GIT_COMMITTER_EMAIL: traeGitEmail,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  attachProcessLogs(traeProcess, "Trae", jobKey);
}
