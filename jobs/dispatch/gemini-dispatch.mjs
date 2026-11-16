/**
 * Gemini agent launch boundary. Keeps validation, Warp gating, CLI launch and
 * process log registration in the original order with bridge-owned adapters.
 */
export async function dispatchGeminiAgent({
  job, filename, workspace, jobKey, credential,
  geminiBin, geminiLaunchMode, geminiArgsTemplate,
  jobStore, extractPromptContext, startGeminiInWarp,
  buildGeminiLaunch, buildGenericArgs, maskArg, attachProcessLogs,
  spawnProcess, platform = process.platform, logger = console,
}) {
  if (!geminiBin) {
    await jobStore.transition(jobKey, "failed", { error: "GEMINI_BIN not configured" });
    logger.error("GEMINI_BIN is not configured. Job saved but Gemini was not started.");
    return;
  }

  const promptContext = extractPromptContext(job);
  if (!promptContext) {
    await jobStore.transition(jobKey, "failed", { error: "Missing Gemini promptContext" });
    logger.error("Gemini skipped. No promptContext found.");
    return;
  }

  if (geminiLaunchMode === "warp") {
    if (platform !== "darwin") {
      await jobStore.transition(jobKey, "failed", {
        error: "Gemini Warp mode requires macOS; use GEMINI_LAUNCH_MODE=headless on Ubuntu",
      });
      return;
    }
    await startGeminiInWarp(promptContext, filename, workspace, jobKey);
    return;
  }

  const launch = buildGeminiLaunch({
    binary: geminiBin, template: geminiArgsTemplate,
    prompt: promptContext, taskFile: filename, workspace,
    credential, buildArgs: buildGenericArgs,
  });

  logger.log("Gemini job accepted. Spawning Gemini CLI...");
  logger.log(`Gemini binary: ${launch.command}`);
  logger.log(`Gemini workspace: ${workspace}`);
  logger.log(`Gemini args: ${launch.args.map(maskArg).join(" ")}`);

  const geminiProcess = spawnProcess(launch.command, launch.args, launch.options);

  attachProcessLogs(geminiProcess, "Gemini", jobKey);
}
