import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const idOf = (repo, issue) => crypto.createHash("sha256").update(repo + ":" + issue).digest("hex");

/** Durable per-issue checkpoint; intentionally distinct from long-term memU knowledge. */
export function createActiveTaskMemory(root) {
  const dir = path.join(root, "active-task-memory");
  const locks = new Map();
  const fileOf = (repo, issue) => path.join(dir, idOf(repo, issue) + ".json");
  async function read(repo, issue) {
    if (!repo || !issue) return null;
    try { return JSON.parse(await fs.readFile(fileOf(repo, issue), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function update(repo, issue, patch) {
    if (!repo || !issue) return null;
    const key = idOf(repo, issue);
    const pending = locks.get(key) || Promise.resolve();
    const job = pending.catch(() => {}).then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const prior = await read(repo, issue);
      const next = {
        version: 1, repositoryRoot: repo, issueId: issue,
        state: prior?.state || "active", lastJobKey: prior?.lastJobKey || null,
        lastAgent: prior?.lastAgent || null, lastWorkspace: prior?.lastWorkspace || null,
        lastSessionId: prior?.lastSessionId || null, lastSeenAt: prior?.lastSeenAt || null,
        lastVerifiedResult: prior?.lastVerifiedResult || null,
        progress: prior?.progress || [], lastProgressAt: prior?.lastProgressAt || null,
        promotion: prior?.promotion || null,
        ...(typeof patch === "function" ? patch(prior) : patch), updatedAt: new Date().toISOString(),
      };
      const output = fileOf(repo, issue), tmp = output + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await fs.rename(tmp, output);
      } finally { await fs.unlink(tmp).catch(() => {}); }
      return next;
    });
    locks.set(key, job);
    try { return await job; } finally { if (locks.get(key) === job) locks.delete(key); }
  }
  async function progress(repo, issue, { kind = "milestone", summary = "", jobKey = null } = {}) {
    if (!repo || !issue || !["milestone", "tool", "checkpoint", "error"].includes(kind)) return null;
    // Only bounded, redacted descriptions; never store raw model transcripts.
    const clean = String(summary).replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/[\r\n]+/g, " ").slice(0, 240);
    const entry = { at: new Date().toISOString(), kind, summary: clean, jobKey };
    return update(repo, issue, prior => ({
      progress: [...(prior?.progress || []), entry].slice(-20),
      lastProgressAt: entry.at,
    }));
  }
  function recoveryPreamble(record) {
    if (!record) return "";
    return [
      "[LinearBridge durable task checkpoint, non-authoritative]",
      "This is a follow-up for the same issue. Inspect the repository and tests before deciding what remains.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Previous state: " + (record.state || "unknown"),
      "Previous session: " + (record.lastSessionId || "unknown"),
      "Last recorded result: " + (record.lastVerifiedResult || "not verified"),
      ...((record.progress || []).slice(-6).map(item => "Checkpoint: " + item.kind + " - " + item.summary)),
      "Do not recreate existing work without checking it.",
      "[End LinearBridge checkpoint]",
    ].join("\n");
  }
  return { read, update, progress, recoveryPreamble };
}
