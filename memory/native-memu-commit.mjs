import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadMemuRuntime } from "./memu-runtime.mjs";

/**
 * memU 0.10 writes through "commit - --json". This adapter is restricted to
 * disposable SQLite databases until storage-level tenant/agent/repo/issue
 * authorization, reconciliation and live canary have been independently
 * reviewed. It cannot use the configured agent_memory PostgreSQL service.
 */
export async function commitMemuInDisposableDatabase(payload, {
  databasePath, configPath, runtimeLoader = loadMemuRuntime,
  spawnImpl = spawn, timeoutMs = 30000,
} = {}) {
  if (!path.isAbsolute(databasePath || "") ||
      !databasePath.endsWith(".sqlite3") ||
      !databasePath.startsWith(os.tmpdir() + path.sep) ||
      databasePath.includes("..") ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
    throw Error("memU commit requires a disposable SQLite path and bounded timeout");
  const parent = await fs.lstat(path.dirname(databasePath));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid()))
    throw Error("memU disposable directory is not private and owned");
  // Reject preexisting files, including symlinks to a different database:
  // this is a one-shot sandbox adapter, not a way to update a live store.
  try {
    await fs.lstat(databasePath);
    throw Error("memU disposable SQLite database must not already exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!payload || !Array.isArray(payload.recall_files) ||
      payload.recall_files.length !== 1 || !Array.isArray(payload.resource) ||
      payload.resource.length !== 0 || !payload.user?.user_id || !payload.user?.agent_id)
    throw Error("memU commit payload is not approved");
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > 8192)
    throw Error("memU commit input too large");
  const runtime = await runtimeLoader({ configPath });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(runtime.binary, ["commit", "-", "--json"], {
        shell: false, env: { ...runtime.env, MEMU_DB: databasePath },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { reject(Error("memU commit failed to spawn")); return; }
    let stdout = "", settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill(); finish(Error("memU disposable commit timed out"));
    }, timeoutMs);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 65536) {
        child.kill(); finish(Error("memU response exceeded bounds"));
      }
    });
    // The stderr stream is drained but never logged or returned: memU may
    // print database locations and embedding credentials on failures.
    child.stderr.on("data", () => {});
    child.on("error", () => finish(Error("memU disposable commit failed")));
    child.on("close", code => {
      if (code !== 0) return finish(Error("memU disposable commit failed"));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(Error("memU returned invalid commit JSON")); }
    });
    child.stdin.on("error", () => finish(Error("memU input stream failed")));
    child.stdin.end(input);
  });
}
