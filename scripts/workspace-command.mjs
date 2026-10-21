#!/usr/bin/env node
// Select one or all Worker workspaces without installing separate dependencies.
import { spawnSync } from "node:child_process";
const agents = ["antigravity", "chatgpt", "gemini", "trae"];
const [command, requested, ...extra] = process.argv.slice(2);
if (!["dev", "deploy"].includes(command) || !requested || (requested !== "all" && !agents.includes(requested))) {
  console.error("Usage: npm run dev|deploy -- <antigravity|chatgpt|gemini|trae|all> [wrangler args]");
  process.exit(2);
}
if (command === "dev" && requested === "all") {
  console.error("Run dev for a single agent; Wrangler dev stays active until stopped.");
  process.exit(2);
}
for (const agent of (requested === "all" ? agents : [requested])) {
  const result = spawnSync("npm", ["run", command, "--workspace", `linear-${agent}-worker`, "--", ...extra], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
