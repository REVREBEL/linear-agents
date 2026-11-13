import fs from "node:fs/promises";
import path from "node:path";
import { readBody, sendJson } from "./http-helpers.mjs";

/**
 * Handle verified Linear issue-completion cleanup requests.
 * Keeps the bridge's durable job store and Mac cleanup implementation injected
 * rather than introducing another owner of job or remote session state.
 */
export function createIssueCompletionRoute({
  sharedSecret, jobStore, cleanupMacTrae, osxProjectsRoot,
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
    const records = await jobStore.findByIssueId(issueId);
    let cleaned = 0;
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
          !file.includes(`${path.sep}.linear-agent${path.sep}projects${path.sep}`) ||
          !file.includes(`${path.sep}inbox${path.sep}`)) continue;
      await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      await jobStore.transition(record.key, record.state, { inboxClearedAt: new Date().toISOString() });
      cleaned++;
    }
    sendJson(response, 200, { ok: true, issueId, cleaned });
    return true;
  };
}
