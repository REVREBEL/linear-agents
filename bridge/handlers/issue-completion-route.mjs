import fs from "node:fs/promises";
import path from "node:path";
import { readBody, sendJson } from "../server/http-helpers.mjs";

/**
 * Handle verified Linear issue-completion cleanup requests.
 * Keeps the bridge's durable job store and Mac cleanup implementation injected
 * rather than introducing another owner of job or remote session state.
 */
export function createIssueCompletionRoute({
  sharedSecret, jobStore, cleanupMacTrae, osxProjectsRoot,
  onIssueCompletionHint = null,
}) {
  return async function handleIssueCompletionRoute(request, response, { url }) {
    if (request.method !== "POST" || url.pathname !== "/issue-completed") return false;
    if (request.headers.authorization !== `Bearer ${sharedSecret}`) {
      sendJson(response, 401, { ok: false, error: "Unauthorized" });
      return true;
    }
    const body = JSON.parse(await readBody(request));
    const issueId = body?.issueId;
    if (typeof issueId !== "string" || !/^[a-f0-9-]{36}$/i.test(issueId)) {
      sendJson(response, 400, { ok: false, error: "Invalid issueId" });
      return true;
    }
    // The root authority must verify the original admitted task while its
    // canonical taskFile still exists. Its acknowledgment only means a
    // durable operator intent is queued, NEVER that memory was approved.
    // Ordinary cleanup remains unchanged when no exact protected job is
    // pinned, the optional memory feature is off, or the root host refuses.
    let preserveOriginalTask = false;
    if (typeof onIssueCompletionHint === "function") {
      try { preserveOriginalTask = (await onIssueCompletionHint({issueId})) === true; }
      catch { /* failure must not block ordinary issue cleanup */ }
    }
    const records = await jobStore.findByIssueId(issueId);
    let cleaned = 0;
    let retained = 0;
    for (const record of records) {
      if (record.executionHost === "macos" && record.remoteTask) {
        if (record.inboxClearedAt) continue;
        await cleanupMacTrae({ job: {
          operation: "cleanup", agent: "trae",
          jobId: record.remoteTask.jobId,
          repository: record.remoteTask.repository,
          projectId: record.remoteTask.projectId,
          projectsRoot: osxProjectsRoot,
        } });
        await jobStore.transition(record.key, record.state, { inboxClearedAt: new Date().toISOString() });
        cleaned++;
        continue;
      }
      const file = record.taskFile;
      if (typeof file !== "string" || !file.endsWith(".json") ||
          !file.includes(path.sep + ".linear-agent" + path.sep + "projects" + path.sep) ||
          !file.includes(path.sep + "inbox" + path.sep)) continue;
      // Persist a root-accepted retention decision BEFORE acknowledging it.
      // Replayed callbacks may see denied/timeout root hints while a durable
      // native commit is pending; they must never erase the original task.
      if (preserveOriginalTask && record.memoryVerificationPending !== true) {
        await jobStore.transition(record.key, record.state, {
          memoryVerificationPending: true,
        });
      }
      if (preserveOriginalTask || record.memoryVerificationPending === true) {
        retained++;
        continue;
      }
      await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      await jobStore.transition(record.key, record.state, { inboxClearedAt: new Date().toISOString() });
      cleaned++;
    }
    sendJson(response, 200, {
      ok: true, issueId, cleaned,
      ...(retained ? { memoryVerificationPending: true, retained } : {}),
    });
    return true;
  };
}
