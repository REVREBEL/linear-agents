import fs from "node:fs/promises";
import path from "node:path";

/**
 * Persist a claimed delivery whose project route cannot be resolved.
 * The HTTP handler owns authentication, preflight, claim, and response writes.
 * Do not acknowledge a job as accepted when the route is unresolved.
 */
export async function persistUnroutedJob({
  agent, safeJobId, jobKey, job, route, agentJobDirs, jobStore, logger = console,
}) {
  const pendingFile = path.join(agentJobDirs[agent], `${safeJobId}.unrouted.json`);
  await fs.writeFile(pendingFile, JSON.stringify({ reason: route.error, job }, null, 2), { mode: 0o600 });
  await jobStore.transition(jobKey, "unrouted", { error: route.error, taskFile: pendingFile });
  logger.error(`Routing failed: ${route.error}; saved pending job to ${pendingFile}`);
  return { status: 422, body: { ok: false, accepted: false, error: route.error } };
}
