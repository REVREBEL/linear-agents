#!/usr/bin/env node
/** Isolated synthetic commit/retrieve canary; never points at the live memU DB. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadMemuRuntime } from "../memory/memu-runtime.mjs";
import { commitMemuInDisposableDatabase } from "../memory/native-memu-commit.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "abr59-disposable-"));
const databasePath = path.join(root, "memu.sqlite3");
const content = "ABR59 verified disposable local embedding canary: isolated review workflow requires testing.";
const payload = {
  user: { user_id: "synthetic-scope", agent_id: "synthetic-agent" },
  resource: [],
  recall_files: [{ track: "memory", name: "abr59-disposable-canary",
    description: "synthetic isolated memory canary", content }],
};
try {
  const commit = await commitMemuInDisposableDatabase(payload, { databasePath });
  if (!Array.isArray(commit?.recall_files) ||
      !commit.recall_files.some(x => x.name === "abr59-disposable-canary"))
    throw Error("synthetic commit did not confirm expected record");
  const runtime = await loadMemuRuntime();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(runtime.binary,
      ["retrieve", "isolated review workflow synthetic canary", "--json"], {
        env: { ...runtime.env, MEMU_DB: databasePath },
        shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(Error("canary recall timed out")); }, 30000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.length > 131072) child.kill();
    });
    child.stderr.on("data", () => {});
    child.on("error", () => { clearTimeout(timeout); reject(Error("canary recall failed")); });
    child.on("close", status => {
      clearTimeout(timeout);
      if (status !== 0 || output.length > 131072)
        return reject(Error("canary recall failed"));
      try { resolve(JSON.parse(output)); } catch { reject(Error("canary recall invalid JSON")); }
    });
  });
  // The native CLI has no four-field query filter. This proves only synthetic
  // local DB commit/semantic retrieval, NOT tenant-isolated live recall.
  const texts = JSON.stringify(result);
  if (!texts.includes("abr59-disposable-canary") && !texts.includes("synthetic isolated memory canary") &&
      !texts.includes(content)) throw Error("canary recall did not find the synthetic record");
  process.stdout.write(JSON.stringify({ disposable: true, committed: true,
    retrieved: true, model: "nomic-embed-text" }) + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
