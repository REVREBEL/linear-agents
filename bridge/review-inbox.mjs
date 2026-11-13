import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { githubReviewChangeKey, buildGithubReviewPrompt } from "../integrations/github-events.mjs";

// A pending review belongs to the ChatGPT *user* review queue, never the
// ChatGPT CLI Linear agent session. All storage is local, mode 0600.
export function createReviewInbox(jobsDir) {
  const dir = path.join(jobsDir, "github-events", "review-inbox");
  const file = key => path.join(dir, key + ".json");
  const allowed = new Set(["pending", "claimed", "reviewed", "blocked"]);
  async function get(key) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw Error("Invalid review ID");
    try { return JSON.parse(await fs.readFile(file(key), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async function update(key, mutate) {
    // Atomic per-review lock works across bridge processes, not just JS turns.
    const lock = file(key) + ".lock";
    // Concurrent requests wait for the existing atomic lock instead of
    // failing with EEXIST. Stale locks fail closed after a bounded wait.
    let acquired = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw Error("Review inbox busy; existing lock requires reconciliation");
    try {
      const record = await get(key);
      if (!record) return null;
      const next = mutate(record);
      if (!allowed.has(next.state)) throw Error("Invalid review state");
      const tmp = file(key) + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, JSON.stringify(next, null, 2), { flag: "wx", mode: 0o600 });
        await fs.rename(tmp, file(key));
      } finally { await fs.rm(tmp, { force: true }); }
      return next;
    } finally {
      await fs.rmdir(lock);
    }
  }
  return {
    get,
    async enqueue(event, { source, destination }) {
      const reviewId = githubReviewChangeKey(event);
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(event.repository || "") ||
          !Number.isSafeInteger(event.number) || event.number < 1 ||
          !destination?.ok) throw Error("Unroutable review task");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const record = {
        version: 1, reviewId, role: "chatgpt-user-review",
        source, repository: event.repository, number: event.number,
        prUrl: event.url, headSha: event.headSha || null,
        revisionUrl: event.commentUrl || null,
        reason: event.event === "issue_comment" ? "revision-report" : event.action,
        projectIds: destination.projectIds,
        conversationUrl: destination.conversationUrl,
        prompt: buildGithubReviewPrompt(event),
        state: "pending", createdAt: new Date().toISOString(),
      };
      try {
        await fs.writeFile(file(reviewId), JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
        return { created: true, record };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        return { created: false, record: await get(reviewId) };
      }
    },
    async list({ limit = 20, state = "pending" } = {}) {
      if (!allowed.has(state) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("Invalid inbox query");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const entries = (await fs.readdir(dir)).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
      const records = [];
      for (const name of entries) {
        const record = await get(name.slice(0, -5));
        if (record && record.state === state) records.push(record);
      }
      records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return records.slice(0, limit);
    },
    async beginMessageHandoff(reviewId) {
      let started = false;
      const record = await update(reviewId, current => {
        // A crash or timeout has an unknown submission outcome. Never
        // automatically replay that prompt into the same conversation.
        if (current.messageHandoff) return current;
        started = true;
        return { ...current, messageHandoff: {
          state: "attempting", at: new Date().toISOString(),
        } };
      });
      return { started, record };
    },
    async finishMessageHandoff(reviewId, { attempted, error = "" }) {
      return update(reviewId, record => {
        if (record.messageHandoff?.state !== "attempting")
          throw Error("Message handoff not in progress");
        return { ...record, messageHandoff: {
          state: attempted ? "attempted" : "uncertain",
          at: new Date().toISOString(),
          ...(attempted ? {} : { error: String(error).slice(0, 300) }),
        } };
      });
    },
    async claim(reviewId, reviewer) {
      if (!reviewer || typeof reviewer !== "string" || reviewer.length > 128) throw Error("Missing reviewer");
      return update(reviewId, record => {
        if (record.state !== "pending") throw Error("Review already claimed");
        return { ...record, state: "claimed", reviewer, claimedAt: new Date().toISOString() };
      });
    },
    async finish(reviewId, { status, summary, delivery = null }) {
      if (!["reviewed", "blocked"].includes(status) || typeof summary !== "string" ||
          !summary.trim() || summary.length > 4000) throw Error("Invalid review outcome");
      return update(reviewId, record => {
        if (record.state !== "claimed") throw Error("Review must be claimed first");
        if (status === "reviewed" && (!delivery || !Number.isSafeInteger(delivery.githubReviewId) ||
            delivery.githubReviewedCommit !== record.headSha || !delivery.verifiedAt)) {
          throw Error("Published GitHub review evidence required");
        }
        return { ...record, state: status, summary: summary.trim(),
          ...(status === "reviewed" ? { delivery } : {}), reviewedAt: new Date().toISOString() };
      });
    },
  };
}
