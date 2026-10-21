import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Filesystem-backed lifecycle ledger; no external database dependency.
// mkdir is atomic for competing requests to the same delivery on one host.
export function createJobStore(root) {
  const ledger = path.join(root, "job-state");
  const pendingWrites = new Map();
  const entryPath = (key) => path.join(ledger, crypto.createHash("sha256").update(key).digest("hex"));
  async function write(entry, record) {
    const temp = path.join(entry, `state.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(temp, path.join(entry, "state.json"));
  }
  async function read(entry) {
    return JSON.parse(await fs.readFile(path.join(entry, "state.json"), "utf8"));
  }
  return {
    async claim(key, metadata) {
      await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
      const entry = entryPath(key);
      try {
        await fs.mkdir(entry, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // A crash between mkdir and state write is still a claimed delivery.
        let record = null;
        try { record = await read(entry); } catch (readError) {
          if (readError.code !== "ENOENT") throw readError;
        }
        return { created: false, record };
      }
      const record = { key, ...metadata, state: "received", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await write(entry, record);
      return { created: true, record };
    },
    async transition(key, state, updates = {}) {
      // Serialize transitions per delivery to avoid close/spawn and crash races.
      const previous = pendingWrites.get(key) || Promise.resolve();
      const current = previous.catch(() => {}).then(async () => {
        const entry = entryPath(key);
        const record = { ...await read(entry), ...updates, state, updatedAt: new Date().toISOString() };
        await write(entry, record);
        return record;
      });
      pendingWrites.set(key, current);
      try { return await current; } finally {
        if (pendingWrites.get(key) === current) pendingWrites.delete(key);
      }
    },
    async reconcile() {
      await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
      const entries = await fs.readdir(ledger, { withFileTypes: true });
      let interrupted = 0;
      for (const item of entries) {
        if (!item.isDirectory()) continue;
        const entry = path.join(ledger, item.name);
        let record;
        try { record = await read(entry); } catch (error) {
          console.error(`Unrecoverable job ledger entry ${item.name}: ${error.message}`);
          continue;
        }
        if (["received", "queued", "running", "launching"].includes(record.state)) {
          // Do not blindly re-run an agent whose side effects may have succeeded.
          await write(entry, { ...record, previousState: record.state, state: "interrupted", updatedAt: new Date().toISOString(), recoveryReason: "Bridge started without verified completion" });
          interrupted++;
        }
      }
      return interrupted;
    },
    async get(key) { return read(entryPath(key)); },
  };
}
