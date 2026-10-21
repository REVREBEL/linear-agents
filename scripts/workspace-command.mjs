#!/usr/bin/env node
// Select one or all Worker workspaces using one shared root dependency installation.
import { spawnSync } from "node:child_process";
const agents = ["antigravity", "chatgpt", "gemini", "trae", "mock"];
const [command, requested, ...extra] = process.argv.slice(2);
if (!["dev", "deploy", "install", "types"].includes(command) || !requested || (requested !== "all" && !agents.includes(requested))) {
  console.error("Usage: npm run setup|dev|deploy|types -- <antigravity|chatgpt|gemini|trae|mock|all> [args]");
  process.exit(2);
}
if (command === "dev" && requested === "all") {
  console.error("Run dev for a single agent; Wrangler dev stays active until stopped.");
  process.exit(2);
}
if (command === "install") {
  // A script literally named "install" would run automatically during npm install.
  // Use "setup" instead, and install shared dependencies from the repository root.
  const args = requested === "all"
    ? ["install", ...extra]
    : ["install", `--workspace=linear-${requested}-worker`, "--include-workspace-root", ...extra];
  const result = spawnSync("npm", args, { stdio: "inherit", shell: process.platform === "win32" });
  process.exit(result.status ?? 1);
}
for (const agent of (requested === "all" ? agents : [requested])) {
  const result = spawnSync("npm", ["run", command, "--workspace", `linear-${agent}-worker`, "--", ...extra], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
