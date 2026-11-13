import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const key = event => hash(`${event.repository}#${event.number}`);
const safeState = state => ({
  version: 1, repository: state.repository, number: state.number,
  updatedAt: state.updatedAt, lastReviewChange: state.lastReviewChange || null,
  lastCommentId: state.lastCommentId || null, lastHeadSha: state.lastHeadSha || null,
  lastDecision: state.lastDecision || null, lastReason: state.lastReason || null,
  status: state.status || "active", lastEvent: state.lastEvent || null,
});

/**
 * Per-PR short-term working memory. Atomic replace guards against process
 * termination during writing. This is checkpoint state, not semantic memory.
 * Stored alongside the bridge journal and excluded from Git.
 */
export function createGithubTaskMemory(jobsDir) {
  const dir = path.join(jobsDir, "github-events", "task-memory");
  const getPath = event => path.join(dir, key(event) + ".json");
  return {
    async read(event) {
      try { return JSON.parse(await fs.readFile(getPath(event), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async update(event, patch) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const old = await this.read(event);
      const next = safeState({
        ...old, ...patch, repository: event.repository, number: event.number,
        updatedAt: new Date().toISOString(),
      });
      const target = getPath(event);
      const tmp = target + "." + process.pid + "." + hash(String(Math.random())).slice(0, 12) + ".tmp";
      try {
        await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        await fs.rename(tmp, target);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
      return next;
    },
  };
}
