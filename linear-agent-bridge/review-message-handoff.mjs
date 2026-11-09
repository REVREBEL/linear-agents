import path from "node:path";
import { spawn } from "node:child_process";

const safeQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const ID = /^[0-9a-f]{64}$/;

export function reviewSshArgs(env = process.env) {
  const host = env.MAC_SSH_HOST;
  if (!host || !/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith("-"))
    throw Error("MAC_SSH_HOST must be a trusted SSH alias");
  const nodeBin = env.MAC_NODE_BIN || "node";
  if (!/^(?:node|\/[a-zA-Z0-9_./-]+)$/.test(nodeBin) || nodeBin.includes(".."))
    throw Error("Invalid Mac Node executable");
  const root = env.OSX_PROJECTS_ROOT;
  if (!root || !path.posix.isAbsolute(root) || root === "/" || root.includes(".."))
    throw Error("OSX_PROJECTS_ROOT must be an absolute Mac path");
  const runner = env.MAC_REVIEW_RUNNER_PATH ||
    path.posix.join(root, "linear-agents/scripts/macos/chatgpt-shortcuts/review-handoff.mjs");
  if (!path.posix.isAbsolute(runner) || !/^\/[A-Za-z0-9_./-]+$/.test(runner) ||
      runner.split("/").includes("..")) throw Error("Invalid Mac review runner path");
  return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes", host, safeQuote(nodeBin) + " " + safeQuote(runner)];
}

// This call only attempts to submit the initial prompt. The review itself
// is handled by ChatGPT in the existing conversation and its own tools.
export async function sendInitialReviewMessage(record, { env = process.env, spawnImpl = spawn } = {}) {
  if (!ID.test(record?.reviewId || "") || typeof record?.prompt !== "string" ||
      record.prompt.length > 8000 || !record.prompt.trim()) throw Error("Invalid review message");
  const url = new URL(record.conversationUrl);
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.search || url.hash ||
      !/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(url.pathname)) throw Error("Invalid review conversation URL");
  const args = reviewSshArgs(env);
  return new Promise((resolve, reject) => {
    const child = spawnImpl("ssh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", ended = false;
    const finish = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      error ? reject(error) : resolve({ attempted: true, reviewId: record.reviewId });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(Error("Mac review handoff timed out; submission outcome unknown"));
    }, 60000);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-3000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on("error", error => finish(error));
    child.once("error", error => finish(error));
    child.once("close", code => {
      if (code === 0 && stdout.split(/\r?\n/).includes("HANDOFF_ATTEMPTED:" + record.reviewId)) finish();
      else finish(Error("Mac review handoff not acknowledged (exit " + code + "): " + stderr));
    });
    child.stdin.end(JSON.stringify({
      reviewId: record.reviewId,
      conversationUrl: record.conversationUrl,
      prompt: record.prompt,
    }));
  });
}
