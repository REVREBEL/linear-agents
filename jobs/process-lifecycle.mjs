// Shared subprocess lifecycle logging and job-ledger transitions.
// Preserve fire-and-forget transition timing and output strings from the bridge.
export function createProcessLifecycleReporter({ jobStore, logger = console }) {
  function attachProcessLogs(child, label, jobKey, external = false) {
    let launchError = false;
    child.on("spawn", () => { void jobStore.transition(jobKey, "running", { pid: child.pid }).catch(logger.error); });
    child.stdout.on("data", (data) => {
      logger.log(`[${label}-Out]: ${data.toString().trim()}`);
    });
  
    child.stderr.on("data", (data) => {
      logger.error(`[${label}-Err]: ${data.toString().trim()}`);
    });
  
    child.on("error", (error) => {
      launchError = true;
      void jobStore.transition(jobKey, "failed", { error: error.message }).catch(logger.error);
      logger.error(`[${label}-Spawn-Error]: ${error.message}`);
    });
  
    child.on("close", (code, signal) => {
      if (!launchError) {
        const state = code === 0 ? (external ? "awaiting_external" : "completed") : "failed";
        void jobStore.transition(jobKey, state, { exitCode: code, signal }).catch(logger.error);
      }
      logger.log(`[${label}-Exit]: code=${code ?? "null"} signal=${signal ?? "none"}`);
    });
  }
  return attachProcessLogs;
}
