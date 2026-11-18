#!/usr/bin/env node
// Type-check only the six Worker projects, regardless of caller cwd.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getWorkerRegistry } from "./agent-worker-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const agents = getWorkerRegistry(root);

for (const [agent, entry] of agents) {
  const project = path.join(entry.workerDir, "tsconfig.json");
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
console.log(`All ${agents.size} Worker TypeScript checks passed.`);
