#!/usr/bin/env node
// Select one or all Worker workspaces using one shared root dependency installation.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const agents = ["antigravity", "chatgpt", "gemini", "trae", "mock"];
const [command, requestedArg, ...extra] = process.argv.slice(2);
const requested = requestedArg || (command === "types" ? "all" : undefined);
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
  // npm's allowScripts policy is defined at the root; a workspace-scoped
  // install is rejected with EALLOWSCRIPTS. All workers share one root
  // dependency tree, so install the entire workspace set even when a single
  // worker was requested.
  const args = ["install", ...extra];
  const result = spawnSync("npm", args, { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit", shell: process.platform === "win32" });
  process.exit(result.status ?? 1);
}
for (const agent of (requested === "all" ? agents : [requested])) {
  const result = spawnSync("bash", [path.join(root,"scripts/with-env.sh"), "worker", agent, command, ...extra], { cwd:root, stdio:"inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
