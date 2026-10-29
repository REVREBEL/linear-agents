#!/usr/bin/env node
// Type-check only the five Worker projects, regardless of caller cwd.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const agents = ["antigravity", "chatgpt", "gemini", "trae", "mock"];

for (const agent of agents) {
  const project = path.join(root, `linear-${agent}-worker`, "tsconfig.json");
  console.log(`Checking ${agent}...`);
  const result = spawnSync(tsc, ["--project", project, "--noEmit"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Unable to run TypeScript: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("All five Worker TypeScript checks passed.");
