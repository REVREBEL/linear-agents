import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

<<<<<<< HEAD
<<<<<<< HEAD
const idOf = (repo, issue) =>
  crypto.createHash("sha256").update(repo + ":" + issue).digest("hex");
=======
=======
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)

// Checkpoints are data, never an authority to run stale or unsafe instructions.
const SENSITIVE_FIELD = /(?:token|secret|password|passwd|credential|authorization|private[_-]?key|api[_-]?key)/i;
const OPERATIONAL_FIELDS = new Set(["lastJobKey", "jobKey", "issueId", "lastSessionId"]);
export function sanitizeCheckpointText(text) {
  return String(text)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(?:github_pat|gh[pousr]|lin_api|lin_oauth)_[A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
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
<<<<<<< HEAD
>>>>>>> 87022c4 (feat(memory): integrate versioned redacted checkpoints and cross-process lock into incremental memory)
=======
=======
const idOf = (repo, issue) =>
  crypto.createHash("sha256").update(repo + ":" + issue).digest("hex");
>>>>>>> fad6b48 (fix(active-task-memory): address review comments for checkpoint schema)
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)

/**
 * Operational identifiers and non-secret fields that must never be redacted by key name.
 */
export const OPERATIONAL_ALLOWLIST = new Set([
  "lastJobKey",
  "jobKey",
  "idempotencyKey",
  "issueId",
  "lastSessionId",
  "conversationId",
  "agentSessionId",
  "repositoryRoot",
  "schemaVersion",
  "revision",
  "state",
  "status",
  "lastAgent",
  "lastWorkspace",
  "lastSeenAt",
  "lastVerifiedResult",
  "expiresAt",
  "nextAction",
  "artifacts",
  "source",
  "updatedAt",
  "checkpointId",
  "attempt",
]);

/**
<<<<<<< HEAD
<<<<<<< HEAD
 * Check whether a field name represents a sensitive credential, token, key, or secret.
 * Handles camelCase, snake_case, kebab-case, and arbitrary case variations without relying
 * on brittle punctuation boundaries.
 */
export function isSensitiveKey(key) {
  if (OPERATIONAL_ALLOWLIST.has(key)) return false;
  const lower = key.toLowerCase();
  if (
    lower.includes("token") || // accessToken, refreshToken, apiToken, sessionToken, etc.
    lower.includes("secret") || // clientSecret, sharedSecret, webhookSecret, etc.
    lower.includes("password") || // password, passwordHash, etc.
    lower.includes("passwd") ||
    lower.includes("auth") || // authorization, authorizationHeader, authHeader, authToken, etc.
    lower.includes("credential") || // credentials, userCredential, etc.
    lower.includes("privatekey") ||
    lower.includes("apikey") ||
    (lower.endsWith("key") && (
      lower.includes("api") ||
      lower.includes("priv") ||
      lower.includes("sec") ||
      lower.includes("sign") ||
      lower.includes("access") ||
      lower.includes("crypt")
    ))
  ) {
    return true;
  }
  return false;
}
=======
 * Sensitive field name pattern. Matches explicit secret/token/password/credential keys.
 */
export const SENSITIVE_KEY_PATTERN =
  /(?:^|[_\-.])(token|secret|password|passwd|auth|credential|api[_-]?key|private[_-]?key)(?:$|[_\-.])/i;
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
 * Check whether a field name represents a sensitive credential, token, key, or secret.
 * Handles camelCase, snake_case, kebab-case, and arbitrary case variations without relying
 * on brittle punctuation boundaries.
 */
export function isSensitiveKey(key) {
  if (OPERATIONAL_ALLOWLIST.has(key)) return false;
  const lower = key.toLowerCase();
  if (
    lower.includes("token") || // accessToken, refreshToken, apiToken, sessionToken, etc.
    lower.includes("secret") || // clientSecret, sharedSecret, webhookSecret, etc.
    lower.includes("password") || // password, passwordHash, etc.
    lower.includes("passwd") ||
    lower.includes("auth") || // authorization, authorizationHeader, authHeader, authToken, etc.
    lower.includes("credential") || // credentials, userCredential, etc.
    lower.includes("privatekey") ||
    lower.includes("apikey") ||
    (lower.endsWith("key") && (
      lower.includes("api") ||
      lower.includes("priv") ||
      lower.includes("sec") ||
      lower.includes("sign") ||
      lower.includes("access") ||
      lower.includes("crypt")
    ))
  ) {
    return true;
  }
  return false;
}
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)

/**
 * Sanitize high-confidence secrets embedded within free text.
 */
export function sanitizeText(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/Bearer\s+[A-Za-z0-9_\-\.~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/(?:lin_oauth_|lin_api_)[a-zA-Z0-9_\-]{16,}/g, "[REDACTED_LINEAR_TOKEN]")
    .replace(/(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{16,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[a-zA-Z0-9_\-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

/**
 * Recursively sanitize objects and arrays: redacting sensitive field names and sanitizing free text.
 */
export function redact(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === "string") {
        obj[i] = sanitizeText(obj[i]);
      } else if (typeof obj[i] === "object") {
        redact(obj[i]);
      }
    }
    return;
  }
  for (const k of Object.keys(obj)) {
    const val = obj[k];
<<<<<<< HEAD
<<<<<<< HEAD
    if (isSensitiveKey(k)) {
=======
    const isSensitive = !OPERATIONAL_ALLOWLIST.has(k) && SENSITIVE_KEY_PATTERN.test(k);
    if (isSensitive) {
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
    if (isSensitiveKey(k)) {
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
      obj[k] = "[REDACTED]";
    } else if (typeof val === "string") {
      obj[k] = sanitizeText(val);
    } else if (val && typeof val === "object") {
      redact(val);
    }
  }
}

/**
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
 * Canonical mapping between state and lifecycle status.
 */
export const STATE_TO_STATUS = Object.freeze({
  "active": "active",
  "agent-finished": "completed",
  "needs-recovery": "needs-recovery",
  "pending": "pending",
});

export const STATUS_TO_STATE = Object.freeze({
  "active": "active",
  "in-progress": "active",
  "running": "active",
  "completed": "agent-finished",
  "done": "agent-finished",
  "finished": "agent-finished",
  "needs-recovery": "needs-recovery",
  "failed": "needs-recovery",
  "pending": "pending",
});

<<<<<<< HEAD
export const VALID_STATES = new Set(Object.keys(STATE_TO_STATUS));
export const VALID_STATUSES = new Set(Object.keys(STATUS_TO_STATE));

/**
 * Validate compatibility between state and status with strict rejection of unknown values.
 */
export function validateStateStatusCompatibility(state, status) {
  if (state && !VALID_STATES.has(state)) {
    const err = new Error(
      `Unknown lifecycle state "${state}". Allowed states: ${Array.from(VALID_STATES).join(", ")}`
=======
/**
 * Validate compatibility between state and status.
 */
export function validateStateStatusCompatibility(state, status) {
  if (!state || !status) return true;
  const expectedState = STATUS_TO_STATE[status];
  if (expectedState && expectedState !== state) {
    const err = new Error(
      `Incompatible lifecycle status "${status}" for state "${state}" (expected status "${STATE_TO_STATUS[state] || state}")`
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
    );
    err.code = "EINVAL_STATE_STATUS";
    throw err;
  }
<<<<<<< HEAD
  if (status && !VALID_STATUSES.has(status)) {
    const err = new Error(
      `Unknown lifecycle status "${status}". Allowed statuses: ${Array.from(VALID_STATUSES).join(", ")}`
    );
    err.code = "EINVAL_STATE_STATUS";
    throw err;
  }
  if (state && status) {
    const expectedState = STATUS_TO_STATE[status];
    if (expectedState !== state) {
      const err = new Error(
        `Incompatible lifecycle status "${status}" for state "${state}" (expected status "${STATE_TO_STATUS[state] || state}")`
      );
      err.code = "EINVAL_STATE_STATUS";
      throw err;
    }
  }
=======
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
  return true;
}

/**
<<<<<<< HEAD
 * Derive lifecycle status consistently from state.
 */
export function deriveStatusFromState(state) {
  return STATE_TO_STATUS[state] || state || "pending";
=======
 * Derive lifecycle status consistently from state.
 */
export function deriveStatusFromState(state) {
  switch (state) {
    case "active":
      return "active";
    case "agent-finished":
      return "completed";
    case "needs-recovery":
      return "needs-recovery";
    default:
      return state || "pending";
  }
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
 * Derive lifecycle status consistently from state.
 */
export function deriveStatusFromState(state) {
  return STATE_TO_STATUS[state] || state || "pending";
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
}

/**
 * Determine whether a checkpoint record has passed its expiration time.
 */
export function isCheckpointExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false;
  const expiry = new Date(record.expiresAt).getTime();
  return !Number.isNaN(expiry) && expiry <= now;
}

/**
<<<<<<< HEAD
<<<<<<< HEAD
 * Check whether a process with the given PID is actively running on this host.
 */
export function isProcessAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // Process exists, insufficient permissions to signal
  }
}

/**
 * Cross-process mutual exclusion via atomic directory creation (mkdir) with owner nonce.
 *
 * Guarantees:
 * - Atomic mutual exclusion: `fs.mkdir(lockDir)` is atomic on POSIX (O_CREAT | O_EXCL).
 * - Exact owner tracking: Owner writes `${lockDir}/${nonce}.owner` with PID, hostname, and timestamp.
 * - Safe release: Owner unlinks its exact `${nonce}.owner` and calls `rmdir(lockDir)`.
 *   If any other file exists in `lockDir`, `rmdir` fails with ENOTEMPTY and preserves it.
 * - Stale dead-lock reclamation without races: If owner PID is dead on this host,
 *   reclaimer unlinks only the specific dead `${deadNonce}.owner` and rmdirs the directory.
 *   If a successor acquired between read and reclaim, unlinking throws ENOENT and rmdir
 *   fails with ENOTEMPTY, completely protecting the successor's live lock.
 * - No background heartbeat: Eliminates all asynchronous timer/rename races.
 */
export async function withCrossProcessLock(lockDir, fn, options = {}) {
  const timeoutMs = options.lockTimeoutMs ?? 5000;
  const retryIntervalMs = options.retryIntervalMs ?? 25;
  const start = Date.now();
  const lockNonce = crypto.randomUUID();
  let acquired = false;

  while (!acquired) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      // Successfully created lock directory! Write our owner file
      const ownerFile = path.join(lockDir, `${lockNonce}.owner`);
      const ownerData = JSON.stringify({
        nonce: lockNonce,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: Date.now(),
      });
      await fs.writeFile(ownerFile, ownerData, { flag: "wx", mode: 0o600 });
      acquired = true;
    } catch (err) {
      if (err.code === "EEXIST") {
        // Lock directory exists. Inspect owner liveness before making any reclamation attempt.
        try {
          const entries = await fs.readdir(lockDir).catch(() => []);
          const ownerFiles = entries.filter((f) => f.endsWith(".owner"));

          if (ownerFiles.length > 0) {
            const targetOwnerFile = ownerFiles[0];
            const content = await fs.readFile(path.join(lockDir, targetOwnerFile), "utf8");
            const parsed = JSON.parse(content);
            const isSameHost = parsed.hostname === os.hostname();

            if (isSameHost && typeof parsed.pid === "number") {
              const alive = isProcessAlive(parsed.pid);
              if (!alive) {
                // Owner PID is dead on this host! Attempt safe reclamation by removing dead owner file(s).
                // Identify dead owner files (could be multiple due to previous crashes).
                const deadOwnerFiles = ownerFiles.filter(f => {
                  try {
                    const content = fs.readFileSync(path.join(lockDir, f), "utf8");
                    const parsed = JSON.parse(content);
                    return parsed.hostname === os.hostname() && !isProcessAlive(parsed.pid);
                  } catch {
                    return false;
                  }
                });
                // Attempt to unlink each dead owner file.
                for (const deadFile of deadOwnerFiles) {
                  try {
                    await fs.unlink(path.join(lockDir, deadFile));
                  } catch {}
                }
                // After cleaning dead owners, try removing the lock directory if it is now empty.
                try {
                  await fs.rmdir(lockDir);
                  // Directory removed, retry acquisition.
                  continue;
                } catch {
                  // Could not remove (likely non‑empty or race). Abort reclamation this round.
                }
                const reclaimTmp = `${lockDir}.reclaim.${crypto.randomUUID()}`;
                try {
                  // Atomically move the lock directory to a temporary name.
                  await fs.rename(lockDir, reclaimTmp);
                  // Remove the reclaimed lock directory safely.
                  await fs.rm(reclaimTmp, { recursive: true, force: true });
                  continue; // Retry acquiring lock immediately.
                } catch {
                  // Rename failed – another contender likely created a lock; abort reclamation.
                }
              }
            }
            // Owner process is alive: NEVER STEAL. Wait for release.
          } else {
// Lock directory exists but empty (abandoned before owner file written or during release)
                // Instead of deleting, wait briefly and retry acquisition to avoid race with concurrent creator.
                await new Promise(r => setTimeout(r, retryIntervalMs));
                continue;
          }
        } catch {
          // Directory inaccessible or concurrently modified; proceed to retry
        }

        if (Date.now() - start >= timeoutMs) {
          const timeoutErr = new Error(`Lock acquisition timed out for ${lockDir}`);
=======
 * Cross-process file locking via atomic exclusive file creation (O_CREAT | O_EXCL).
 */
export async function withCrossProcessLock(lockFile, fn, options = {}) {
  const timeoutMs = options.lockTimeoutMs ?? 5000;
  const retryIntervalMs = options.retryIntervalMs ?? 25;
  const staleThresholdMs = options.staleThresholdMs ?? 10000;
  const start = Date.now();

  while (true) {
    try {
      const lockData = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      await fs.writeFile(lockFile, lockData, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const content = await fs.readFile(lockFile, "utf8");
          const parsed = JSON.parse(content);
          if (Date.now() - parsed.createdAt > staleThresholdMs) {
            await fs.unlink(lockFile).catch(() => {});
            continue;
          }
        } catch {
          // If unreadable or concurrently unlinked, proceed to retry
        }

        if (Date.now() - start >= timeoutMs) {
          const timeoutErr = new Error(`Lock acquisition timed out for ${lockFile}`);
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
          timeoutErr.code = "ELOCKED";
          throw timeoutErr;
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      } else {
        throw err;
      }
    }
  }

  try {
<<<<<<< HEAD
    if (options._onLockAcquired) {
      await options._onLockAcquired();
    }
    if (options._holdLockMs) {
      await new Promise((resolve) => setTimeout(resolve, options._holdLockMs));
    }
    return await fn();
  } finally {
    // Safe release: ONLY remove our own owner file, then remove lock directory
    try {
      await fs.unlink(path.join(lockDir, `${lockNonce}.owner`)).catch(() => {});
      await fs.rmdir(lockDir).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
=======
    return await fn();
  } finally {
    await fs.unlink(lockFile).catch(() => {});
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
  }
}

/**
<<<<<<< HEAD
 * Durable per-issue checkpoint; intentionally distinct from long-term memU knowledge.
 *
 * Concurrency and transactional safety:
 * - Cross-process single-writer locking via exclusive directory lock (`.lock` via mkdir).
 * - Process-level queuing to minimize file-lock contention within a single runtime instance.
 * - CAS optimistic concurrency validation via `expectedRevision` evaluated freshly under the lock.
 * - Atomic rename writes (`tmp` -> target) ensuring zero visible partial files.
=======
 * Durable per-issue checkpoint; intentionally distinct from long-term memU knowledge.
 *
 * Concurrency model:
 * - Single-process writer per host (managed by local bridge LaunchAgent/systemd).
 * - In-memory serialization via Promise queue per checkpoint key.
 * - Cross-process / optimistic CAS validation via `expectedRevision` in patch/options.
 * - Atomic file writes via temporary file and atomic rename.
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
 * Durable per-issue checkpoint; intentionally distinct from long-term memU knowledge.
 *
 * Concurrency and transactional safety:
 * - Cross-process single-writer locking via exclusive file lock (`.lock` with O_CREAT | O_EXCL).
 * - Process-level queuing to minimize file-lock contention within a single runtime instance.
 * - CAS optimistic concurrency validation via `expectedRevision` evaluated freshly under the lock.
 * - Atomic rename writes (`tmp` -> target) ensuring zero visible partial files.
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
 */
export function createActiveTaskMemory(root) {
  const dir = path.join(root, "active-task-memory");
  const locks = new Map();
  const fileOf = (repo, issue) => path.join(dir, idOf(repo, issue) + ".json");
<<<<<<< HEAD
<<<<<<< HEAD
  const lockOf = (repo, issue) => fileOf(repo, issue) + ".lock";
=======
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
  const lockOf = (repo, issue) => fileOf(repo, issue) + ".lock";
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)

  async function read(repo, issue) {
    if (!repo || !issue) return null;
    try {
      const data = JSON.parse(await fs.readFile(fileOf(repo, issue), "utf8"));
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function update(repo, issue, patch, options = {}) {
    if (!repo || !issue) return null;
    const key = idOf(repo, issue);
<<<<<<< HEAD
    const lockDir = lockOf(repo, issue);
=======
    const lockFile = lockOf(repo, issue);
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)

    // In-process serialization queue
    const pending = locks.get(key) || Promise.resolve();
    const job = pending.catch(() => {}).then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD

      // Cross-process mutual exclusion
      return await withCrossProcessLock(lockDir, async () => {
        // Read current state freshly from disk under the lock
        const prior = await read(repo, issue);

        // Transactional CAS: validate expectedRevision under the lock
        const expectedRevision = options.expectedRevision ?? patch?.expectedRevision;
        if (expectedRevision !== undefined) {
          const currentRevision = prior?.revision ?? 0;
          if (currentRevision !== expectedRevision) {
            const conflictErr = new Error(
              `Revision conflict for ${repo}:${issue}: expected revision ${expectedRevision}, but found ${currentRevision}`
            );
            conflictErr.code = "ECONFLICT";
            conflictErr.expectedRevision = expectedRevision;
            conflictErr.currentRevision = currentRevision;
            throw conflictErr;
          }
        }

        // Determine state and lifecycle status consistently
        let state = patch?.state || prior?.state || "active";
        let status;

        if (patch?.status && patch?.state) {
          validateStateStatusCompatibility(patch.state, patch.status);
          state = patch.state;
          status = patch.status;
        } else if (patch?.state) {
          validateStateStatusCompatibility(patch.state, null);
          state = patch.state;
          status = STATE_TO_STATUS[state] || "active";
        } else if (patch?.status) {
          validateStateStatusCompatibility(null, patch.status);
          state = STATUS_TO_STATE[patch.status] || state;
          validateStateStatusCompatibility(state, patch.status);
          status = patch.status;
        } else {
          state = prior?.state || "active";
          status = prior?.status && STATUS_TO_STATE[prior.status] === state
            ? prior.status
            : (STATE_TO_STATUS[state] || "active");
        }

        // Clean patch of internal options
        const patchData = { ...patch };
        delete patchData.expectedRevision;

        // Build base checkpoint
        const nextBase = {
          schemaVersion: 2,
          revision: (prior?.revision ?? 0) + 1,
          repositoryRoot: repo,
          issueId: issue,
          state,
          status,
          lastJobKey: prior?.lastJobKey || null,
          lastAgent: prior?.lastAgent || null,
          lastWorkspace: prior?.lastWorkspace || null,
          lastSessionId: prior?.lastSessionId || null,
          lastSeenAt: prior?.lastSeenAt || null,
          lastVerifiedResult: prior?.lastVerifiedResult || null,
          expiresAt: prior?.expiresAt || null,
          nextAction: prior?.nextAction || null,
          artifacts: prior?.artifacts || [],
          source: prior?.source || null,
          ...patchData,
          updatedAt: new Date().toISOString(),
        };

        // Clone and sanitize/redact
        const next = JSON.parse(JSON.stringify(nextBase));
        redact(next);

        const output = fileOf(repo, issue);
        const tmp = output + "." + crypto.randomUUID() + ".tmp";
        try {
          await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", {
            mode: 0o600,
            flag: "wx",
          });
          await fs.rename(tmp, output);
        } finally {
          await fs.unlink(tmp).catch(() => {});
        }
        return next;
      }, options);
=======
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
>>>>>>> 74d2468 (feat(memory): persist bounded progress milestones during tasks)
=======
=======
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
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
<<<<<<< HEAD
>>>>>>> 87022c4 (feat(memory): integrate versioned redacted checkpoints and cross-process lock into incremental memory)
=======
=======
      const prior = await read(repo, issue);
=======
>>>>>>> 2ac9da0 (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)

      // Cross-process mutual exclusion
      return await withCrossProcessLock(lockFile, async () => {
        // Read current state freshly from disk under the lock
        const prior = await read(repo, issue);

        // Transactional CAS: validate expectedRevision under the lock
        const expectedRevision = options.expectedRevision ?? patch?.expectedRevision;
        if (expectedRevision !== undefined) {
          const currentRevision = prior?.revision ?? 0;
          if (currentRevision !== expectedRevision) {
            const conflictErr = new Error(
              `Revision conflict for ${repo}:${issue}: expected revision ${expectedRevision}, but found ${currentRevision}`
            );
            conflictErr.code = "ECONFLICT";
            conflictErr.expectedRevision = expectedRevision;
            conflictErr.currentRevision = currentRevision;
            throw conflictErr;
          }
        }

        // Determine state and lifecycle status consistently
        let state = patch?.state || prior?.state || "active";
        let status;

        if (patch?.status && patch?.state) {
          validateStateStatusCompatibility(patch.state, patch.status);
          status = patch.status;
        } else if (patch?.state) {
          status = STATE_TO_STATUS[patch.state] || patch.state;
        } else if (patch?.status) {
          state = STATUS_TO_STATE[patch.status] || state;
          validateStateStatusCompatibility(state, patch.status);
          status = patch.status;
        } else {
          state = prior?.state || "active";
          status = prior?.status && STATUS_TO_STATE[prior.status] === state
            ? prior.status
            : (STATE_TO_STATUS[state] || "active");
        }

        // Clean patch of internal options
        const patchData = { ...patch };
        delete patchData.expectedRevision;

        // Build base checkpoint
        const nextBase = {
          schemaVersion: 2,
          revision: (prior?.revision ?? 0) + 1,
          repositoryRoot: repo,
          issueId: issue,
          state,
          status,
          lastJobKey: prior?.lastJobKey || null,
          lastAgent: prior?.lastAgent || null,
          lastWorkspace: prior?.lastWorkspace || null,
          lastSessionId: prior?.lastSessionId || null,
          lastSeenAt: prior?.lastSeenAt || null,
          lastVerifiedResult: prior?.lastVerifiedResult || null,
          expiresAt: prior?.expiresAt || null,
          nextAction: prior?.nextAction || null,
          artifacts: prior?.artifacts || [],
          source: prior?.source || null,
          ...patchData,
          updatedAt: new Date().toISOString(),
        };

<<<<<<< HEAD
      const output = fileOf(repo, issue);
      const tmp = output + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(tmp, output);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
      return next;
>>>>>>> fad6b48 (fix(active-task-memory): address review comments for checkpoint schema)
<<<<<<< HEAD
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
=======
        // Clone and sanitize/redact
        const next = JSON.parse(JSON.stringify(nextBase));
        redact(next);

        const output = fileOf(repo, issue);
        const tmp = output + "." + crypto.randomUUID() + ".tmp";
        try {
          await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", {
            mode: 0o600,
            flag: "wx",
          });
          await fs.rename(tmp, output);
        } finally {
          await fs.unlink(tmp).catch(() => {});
        }
        return next;
      });
>>>>>>> 2ac9da0 (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
    });

    locks.set(key, job);
    try {
      return await job;
    } finally {
      if (locks.get(key) === job) locks.delete(key);
    }
  }
<<<<<<< HEAD
<<<<<<< HEAD

  function recoveryPreamble(record, options = {}) {
=======
=======
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
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
>>>>>>> 74d2468 (feat(memory): persist bounded progress milestones during tasks)
    if (!record) return "";
<<<<<<< HEAD
    const now = options.now ?? Date.now();
    const expired = isCheckpointExpired(record, now);

    if (expired) {
      return [
        "[LinearBridge durable task checkpoint, non-authoritative - STALE]",
        "This checkpoint is EXPIRED and STALE. Stale next action has been completely suppressed.",
        "A live Linear/GitHub/checkout refresh is REQUIRED before taking action.",
        "Previous agent: " + (record.lastAgent || "unknown"),
        "Previous state: expired (stale " + (record.state || "unknown") + ")",
        "Previous session: " + (record.lastSessionId || "unknown"),
        "Last recorded result: " + (record.lastVerifiedResult || "not verified"),
        "Next action: none (suppressed due to checkpoint expiration)",
        "Expires at: " + record.expiresAt + " [EXPIRED - STALE]",
        "Do not execute any prior unverified instructions without refreshing live issue and Git status.",
        "[End LinearBridge checkpoint]",
      ].join("\n");
    }

=======
    if (isCheckpointExpired(record)) return [
      "[LinearBridge durable task checkpoint, EXPIRED]",
      "The saved next action is stale. Refresh the Linear issue, Git state, and test evidence before proceeding.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Next action: suppressed (expired checkpoint)",
      "[End LinearBridge checkpoint]",
<<<<<<< HEAD
    ].join("\\n");
>>>>>>> 87022c4 (feat(memory): integrate versioned redacted checkpoints and cross-process lock into incremental memory)
=======
    ].join("\n");
<<<<<<< HEAD
>>>>>>> 762f620 (fix(memory): write canonical JSON line terminators and recovery preamble formatting)
=======
=======

  function recoveryPreamble(record, options = {}) {
    if (!record) return "";
    const now = options.now ?? Date.now();
    const expired = isCheckpointExpired(record, now);

    if (expired) {
      return [
        "[LinearBridge durable task checkpoint, non-authoritative - STALE]",
        "This checkpoint is EXPIRED and STALE. Stale next action has been completely suppressed.",
        "A live Linear/GitHub/checkout refresh is REQUIRED before taking action.",
        "Previous agent: " + (record.lastAgent || "unknown"),
        "Previous state: expired (stale " + (record.state || "unknown") + ")",
        "Previous session: " + (record.lastSessionId || "unknown"),
        "Last recorded result: " + (record.lastVerifiedResult || "not verified"),
        "Next action: none (suppressed due to checkpoint expiration)",
        "Expires at: " + record.expiresAt + " [EXPIRED - STALE]",
        "Do not execute any prior unverified instructions without refreshing live issue and Git status.",
        "[End LinearBridge checkpoint]",
      ].join("\n");
    }

>>>>>>> fad6b48 (fix(active-task-memory): address review comments for checkpoint schema)
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
    return [
      "[LinearBridge durable task checkpoint, non-authoritative]",
      "This is a follow-up for the same issue. Inspect the repository and tests before deciding what remains.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Previous state: " + (record.state || "unknown"),
      "Previous session: " + (record.lastSessionId || "unknown"),
      "Last recorded result: " + (record.lastVerifiedResult || "not verified"),
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
      "Next action: " + (record.nextAction || "none"),
      "Expires at: " + (record.expiresAt || "none"),
=======
=======
      "Next action: " + (record.nextAction || "none"),
      "Expires at: " + (record.expiresAt || "none"),
>>>>>>> 87022c4 (feat(memory): integrate versioned redacted checkpoints and cross-process lock into incremental memory)
      ...((record.progress || []).slice(-6).map(item => "Checkpoint: " + item.kind + " - " + item.summary)),
<<<<<<< HEAD
>>>>>>> 74d2468 (feat(memory): persist bounded progress milestones during tasks)
=======
=======
      "Next action: " + nextActionDisplay,
      "Expires at: " + expiresDisplay,
>>>>>>> fad6b48 (fix(active-task-memory): address review comments for checkpoint schema)
<<<<<<< HEAD
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
=======
=======
      "Next action: " + (record.nextAction || "none"),
      "Expires at: " + (record.expiresAt || "none"),
>>>>>>> 2ac9da0 (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
>>>>>>> 92a0b9a (fix(active-task-memory): address follow-up review for cross-process CAS, secret redaction, and status contract)
      "Do not recreate existing work without checking it.",
      "[End LinearBridge checkpoint]",
    ].join("\n");
  }
<<<<<<< HEAD
<<<<<<< HEAD

  return { read, update, recoveryPreamble };
=======
  return { read, update, progress, recoveryPreamble };
>>>>>>> 74d2468 (feat(memory): persist bounded progress milestones during tasks)
=======
  return { read, update, progress, recoveryPreamble };
=======

  return { read, update, recoveryPreamble };
>>>>>>> fad6b48 (fix(active-task-memory): address review comments for checkpoint schema)
>>>>>>> 5cd86bb (fix(active-task-memory): address review comments for checkpoint schema)
}
