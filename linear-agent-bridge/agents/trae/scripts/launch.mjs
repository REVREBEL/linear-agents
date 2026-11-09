#!/usr/bin/env node
// Restricted SSH entry point for Trae on a trusted macOS host.
// Reads exactly one JSON request on stdin; no shell evaluation or SCP required.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const maxBytes = 1024 * 1024;
async function input() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > maxBytes) throw Error("Request too large");
  }
  return JSON.parse(text);
}
export async function validateRemoteJob(message, fsApi = fs) {
  if (message?.agent !== "trae" ||
      !/^[a-zA-Z0-9._-]{1,160}$/.test(message.jobId || "") ||
      !/^REVREBEL\/[a-zA-Z0-9._-]+$/.test(message.repository || "")) throw Error("Invalid remote job identity");
  const base = message.projectsRoot;
  if (typeof base !== "string" || !path.isAbsolute(base) || base === "/") throw Error("Invalid remote projects root");
  const realBase = await fsApi.realpath(base);
  const repositoryPath = path.resolve(base, message.repository.split("/")[1]);
  const root = await fsApi.realpath(repositoryPath);
  if (!root.startsWith(realBase + path.sep)) throw Error("Repository escaped configured root");
  if (!(await fsApi.stat(path.join(root, ".git"))).isDirectory()) throw Error("Not a Git checkout");
  const scope = message.projectScope || ".";
  if (typeof scope !== "string" || path.isAbsolute(scope) || scope.includes("\0")) throw Error("Invalid project scope");
  const scoped = await fsApi.realpath(path.resolve(root, scope));
  if (scoped !== root && !scoped.startsWith(root + path.sep)) throw Error("Project scope escaped repository");
  if (!(await fsApi.stat(scoped)).isDirectory()) throw Error("Project scope is not a directory");
  const workspace = message.launchFromScope === true ? scoped : root;
  if (typeof message.prompt !== "string" || !message.prompt.trim()) throw Error("Missing prompt");
  if (!/^[a-fA-F0-9-]{36}$/.test(message.agentSessionId || "")) throw Error("Invalid agent session ID");
  if (typeof message.accessToken !== "string" || !message.accessToken) throw Error("Missing agent access token");
  return { root, workspace };
}
export async function excludeAgentRuntime(root, fsApi = fs, runGit = run) {
  const { stdout } = await runGit("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"]);
  const file = path.isAbsolute(stdout.trim()) ? stdout.trim() : path.resolve(root, stdout.trim());
  await fsApi.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let content = "";
  try { content = await fsApi.readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!content.split(/\r?\n/).includes("/.linear-agent/")) {
    await fsApi.appendFile(file, (content.endsWith("\n") || !content ? "" : "\n") + "/.linear-agent/\n", { mode: 0o600 });
  }
  const tracked = await runGit("git", ["-C", root, "ls-files", "--", ".linear-agent"]);
  if (tracked.stdout.trim()) throw Error("Refusing agent runtime writes: .linear-agent is tracked");
}
export async function cleanupRemoteInbox(message, fsApi = fs) {
  if (message?.operation !== "cleanup" || message.agent !== "trae" ||
      !/^[a-zA-Z0-9._-]{1,160}$/.test(message.jobId || "") ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(message.projectId || "") ||
      !/^REVREBEL\/[a-zA-Z0-9._-]+$/.test(message.repository || "")) {
    throw Error("Invalid remote cleanup identity");
  }
  if (!path.isAbsolute(message.projectsRoot) || message.projectsRoot === "/") throw Error("Invalid cleanup root");
  const base = await fsApi.realpath(message.projectsRoot);
  const repository = await fsApi.realpath(path.join(base, message.repository.split("/")[1]));
  if (!repository.startsWith(base + path.sep)) throw Error("Cleanup escapes trusted root");
  const inbox = path.join(repository, ".linear-agent", "projects", message.projectId, "inbox");
  const filename = path.join(inbox, message.jobId + ".json");
  // A symlinked runtime directory must not make cleanup escape the checkout.
  const realInbox = await fsApi.realpath(inbox).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!realInbox) return false;
  if (!realInbox.startsWith(repository + path.sep)) throw Error("Cleanup inbox escapes repository");
  await fsApi.unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
  return true;
}
export async function main() {
  if (process.platform !== "darwin") throw Error("Remote runner must execute on macOS");
  const message = await input();
  if (message.operation === "cleanup") {
    await cleanupRemoteInbox(message);
    console.log("REMOTE_CLEANED:" + message.jobId);
    return;
  }
  const { root, workspace } = await validateRemoteJob(message);
  await excludeAgentRuntime(root);
  const taskDir = path.join(root, ".linear-agent", "projects", message.projectId, "inbox");
  await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
  const taskFile = path.join(taskDir, message.jobId + ".json");
  const task = { ...message.job, resolvedRouting: {
    repositoryRoot: root, projectScope: message.projectScope, launchDirectory: workspace,
    executionHost: "macos", linearProjectId: message.projectId
  } };
  // Do not copy the access token into the long-term task file.
  await fs.writeFile(taskFile, JSON.stringify(task, null, 2), { flag: "wx", mode: 0o600 });
  const binary = message.traeBin || "trae";
  if (!/^(?:[a-zA-Z0-9_.-]+|\/[a-zA-Z0-9_./-]+)$/.test(binary) || binary.includes("..")) {
    throw Error("Invalid Trae executable");
  }
  const gitName = (message.githubAppName || "revrebel-trae") + "[bot]";
  const gitEmail = (message.githubAppId || "5660644") + "+" + gitName + "@users.noreply.github.com";
  const child = spawn(binary, ["chat", "--reuse-window", "--maximize", message.prompt], {
    cwd: workspace,
    env: {
      ...process.env,
      TRAE_LINEAR_API_KEY: message.accessToken,
      LINEAR_API_KEY: "",
      LINEAR_ACCESS_TOKEN: "",
      GIT_AUTHOR_NAME: gitName, GIT_COMMITTER_NAME: gitName,
      GIT_AUTHOR_EMAIL: gitEmail, GIT_COMMITTER_EMAIL: gitEmail,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // The Ubuntu dispatcher requires this ACK before reporting acceptance.
  console.log("REMOTE_ACCEPTED:" + message.jobId);
  child.stdout.on("data", chunk => process.stdout.write(chunk));
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  const code = await new Promise(resolve => child.once("close", resolve));
  if (code !== 0) throw Error("Trae exited with code " + code);
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => { console.error("REMOTE_ERROR: " + error.message); process.exitCode = 1; });
}
