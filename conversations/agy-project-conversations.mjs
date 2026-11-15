import fs from "node:fs/promises";
import path from "node:path";

/**
 * Keep AGY project-conversation persistence rooted in the bridge's existing
 * job-data directory. This source extraction does not migrate live files.
 */
export function createAgyProjectConversationStore(jobsDir) {
  const AGY_PROJECT_CONVERSATIONS_DIR = path.join(jobsDir, "project-conversations");
  function projectConversationFile(projectId) {
    if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
      throw new Error("Invalid AGY project ID");
    }
    return path.join(AGY_PROJECT_CONVERSATIONS_DIR, projectId + ".json");
  }

  async function readAgyProjectConversation(projectId, workspace) {
    const file = projectConversationFile(projectId);
    try {
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      return record.projectId === projectId &&
        record.workspace === workspace &&
        typeof record.conversationId === "string" &&
        /^[a-zA-Z0-9_-]{8,128}$/.test(record.conversationId) ? record.conversationId : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function saveAgyProjectConversation(projectId, workspace, conversationId) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(conversationId)) {
      throw new Error("Cannot persist invalid AGY conversation ID");
    }
    await fs.mkdir(AGY_PROJECT_CONVERSATIONS_DIR, { recursive: true, mode: 0o700 });
    const file = projectConversationFile(projectId);
    const temporary = file + "." + process.pid + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify({
        projectId, workspace, conversationId, updatedAt: new Date().toISOString()
      }, null, 2), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  return { readAgyProjectConversation, saveAgyProjectConversation };
}
