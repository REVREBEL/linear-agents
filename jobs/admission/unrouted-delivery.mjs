import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * A safe filename is not a unique delivery identity: distinct upstream IDs
 * may sanitize to the same visible job ID. Include the raw ledger key hash.
 */
export function unroutedTaskPath({ agent, safeJobId, jobKey, agentJobDirs }) {
  const hash = crypto.createHash("sha256").update(jobKey).digest("hex");
  const prefix = String(safeJobId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return path.join(agentJobDirs[agent], `${prefix}-${hash}.unrouted.json`);
}

/**
 * A duplicate "received" claim (or a post-restart interrupted claim that
 * was previously "received") can safely finish unrouted persistence.
 * Never retry a job that may have launched an agent.
 */
export function canRecoverUnroutedDelivery({ claimed, route, jobKey, agent }) {
  if (route?.ok !== false || claimed?.created) return false;
  const record = claimed.record;
  if (!record || record.key !== jobKey || record.agent !== agent) return false;
  return record.state === "received" ||
    (record.state === "interrupted" && record.previousState === "received");
}

/**
 * The route predicate belongs here, so testing both routed and unrouted
 * deliveries exercises the actual decision used by the HTTP handler.
 */
export async function handleUnroutedDelivery(options) {
  if (options.route?.ok !== false) return null;
  return persistUnroutedJob(options);
}

/**
 * Publish a complete pending task atomically without replacing another
 * delivery's file. Replays verify the original bytes before finishing a
 * missing ledger transition. HTTP acknowledgment stays in the bridge.
 */
export async function persistUnroutedJob({
  agent, safeJobId, jobKey, job, route, agentJobDirs, jobStore, logger = console,
}) {
  const pendingFile = unroutedTaskPath({ agent, safeJobId, jobKey, agentJobDirs });
  const content = JSON.stringify({ reason: route.error, job }, null, 2);
  const temporary = pendingFile + "." + crypto.randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      // link() publishes only a fully written file and fails if the target
      // already exists; rename() could overwrite a different delivery.
      await fs.link(temporary, pendingFile);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.readFile(pendingFile, "utf8");
      if (existing !== content) {
        throw new Error("Unrouted task file collision; manual reconciliation required");
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(logger.error);
  }
  await jobStore.transition(jobKey, "unrouted", { error: route.error, taskFile: pendingFile });
  logger.error(`Routing failed: ${route.error}; saved pending job to ${pendingFile}`);
  return { status: 422, body: { ok: false, accepted: false, error: route.error } };
}
