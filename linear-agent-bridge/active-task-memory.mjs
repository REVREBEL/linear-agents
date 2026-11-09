import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";


// Checkpoints are data, never an authority to run stale or unsafe instructions.
const SENSITIVE_FIELD = /(?:token|secret|password|passwd|credential|authorization|private[_-]?key|api[_-]?key)/i;
const OPERATIONAL_FIELDS = new Set(["lastJobKey", "jobKey", "issueId", "lastSessionId"]);
export function sanitizeCheckpointText(text) {
  return String(text)
    .replace(/Bearer\\s+[^\\s]+/gi, "Bearer [REDACTED]")
    .replace(/(?:github_pat|gh[pousr]|lin_api|lin_oauth)_[A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .replace(/\\bsk-[A-Za-z0-9_-]{20,}\\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/((?:token|password|secret|api[_-]?key)\\s*[:=]\\s*)[^\\s,;]+/gi, "$1[REDACTED]");
}
export function sanitizeCheckpoint(value, depth = 0) {
  if (depth > 20) throw Error("Checkpoint nesting exceeds limit");
  if (typeof value === "string") return sanitizeCheckpointText(value);
  if (Array.isArray(value)) return value.map(item => sanitizeCheckpoint(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, SENSITIVE_FIELD.test(key) && !OPERATIONAL_FIELDS.has(key)
        ? "[REDACTED]" : sanitizeCheckpoint(entry, depth + 1)]));
  }
  return value;
}
const STATUS_FROM_STATE = { active: "active", pending: "pending",
  "agent-finished": "completed", "needs-recovery": "needs-recovery" };
const STATE_FROM_STATUS = { active: "active", pending: "pending", completed: "agent-finished",
  "needs-recovery": "needs-recovery", failed: "needs-recovery", running: "active" };
export function isCheckpointExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false;
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && at <= now;
}
async function withCheckpointLock(filename, action) {
  // Exclusive file creation is atomic across processes. Do not reap a lock
  // merely because a PID appears dead: PID reuse and slow writes make that unsafe.
  const lockfile = filename + ".lock";
  let handle;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      handle = await fs.open(lockfile, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw Error("Checkpoint lock busy; inspect the existing lock before retrying");
  try { return await action(); }
  finally {
    await handle.close();
    await fs.unlink(lockfile).catch(() => {});
  }
}

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
      return withCheckpointLock(fileOf(repo, issue), async () => {
        const prior = await read(repo, issue);
        const input = typeof patch === "function" ? patch(prior) : patch;
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw Error("Checkpoint patch must be an object");
        const { expectedRevision, ...fields } = input;
        if (expectedRevision !== undefined && expectedRevision !== (prior?.revision ?? 0)) {
          const err = Error("Checkpoint revision conflict");
          err.code = "ECONFLICT";
          throw err;
        }
        const state = fields.state ?? (fields.status
          ? STATE_FROM_STATUS[fields.status] : null) ?? prior?.state ?? "active";
        const status = fields.status ?? STATUS_FROM_STATE[state];
        if (!STATUS_FROM_STATE[state] || !STATE_FROM_STATUS[status] ||
            STATE_FROM_STATUS[status] !== state) throw Error("Invalid checkpoint lifecycle");
        const next = sanitizeCheckpoint({
          version: 1, schemaVersion: 2, revision: (prior?.revision ?? 0) + 1,
          repositoryRoot: repo, issueId: issue,
          state, status,
          lastJobKey: prior?.lastJobKey || null,
          lastAgent: prior?.lastAgent || null, lastWorkspace: prior?.lastWorkspace || null,
          lastSessionId: prior?.lastSessionId || null, lastSeenAt: prior?.lastSeenAt || null,
          lastVerifiedResult: prior?.lastVerifiedResult || null,
          progress: prior?.progress || [], lastProgressAt: prior?.lastProgressAt || null,
          promotion: prior?.promotion || null,
          expiresAt: prior?.expiresAt || null, nextAction: prior?.nextAction || null,
          artifacts: prior?.artifacts || [], source: prior?.source || null,
          ...fields, repositoryRoot: repo, issueId: issue,
          state, status, updatedAt: new Date().toISOString(),
        });
        const output = fileOf(repo, issue), tmp = output + "." + crypto.randomUUID() + ".tmp";
        try {
          await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await fs.rename(tmp, output);
        } finally { await fs.unlink(tmp).catch(() => {}); }
        return next;
      });
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
    if (isCheckpointExpired(record)) return [
      "[LinearBridge durable task checkpoint, EXPIRED]",
      "The saved next action is stale. Refresh the Linear issue, Git state, and test evidence before proceeding.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Next action: suppressed (expired checkpoint)",
      "[End LinearBridge checkpoint]",
    ].join("\n");
    return [
      "[LinearBridge durable task checkpoint, non-authoritative]",
      "This is a follow-up for the same issue. Inspect the repository and tests before deciding what remains.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Previous state: " + (record.state || "unknown"),
      "Previous session: " + (record.lastSessionId || "unknown"),
      "Last recorded result: " + (record.lastVerifiedResult || "not verified"),
      "Next action: " + (record.nextAction || "none"),
      "Expires at: " + (record.expiresAt || "none"),
      ...((record.progress || []).slice(-6).map(item => "Checkpoint: " + item.kind + " - " + item.summary)),
      "Do not recreate existing work without checking it.",
      "[End LinearBridge checkpoint]",
    ].join("\n");
  }
  return { read, update, progress, recoveryPreamble };
}
