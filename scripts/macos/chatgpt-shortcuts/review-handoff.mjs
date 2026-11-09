#!/usr/bin/env node
// Executed only by the trusted Ubuntu SSH dispatcher. Does not run a review.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ID = /^[a-f0-9]{64}$/;
function validate(request) {
  if (!request || !ID.test(request.reviewId || "") ||
      typeof request.prompt !== "string" || !request.prompt.trim() ||
      request.prompt.length > 8000) throw Error("Invalid ChatGPT review handoff");
  const url = new URL(request.conversationUrl);
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" ||
      url.search || url.hash || !/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(url.pathname))
    throw Error("Invalid existing ChatGPT review conversation");
  return { conversationUrl: url.href, prompt: request.prompt, handoffId: request.reviewId };
}
export async function runReviewHandoff(input, { run = spawn } = {}) {
  const handoff = validate(input);
  const dir = await mkdtemp(path.join(os.tmpdir(), "linearbridge-review-"));
  const file = path.join(dir, "handoff.json");
  try {
    await writeFile(file, JSON.stringify(handoff), { flag: "wx", mode: 0o600 });
    const runner = path.resolve(import.meta.dirname, "handoff.mjs");
    await new Promise((resolve, reject) => {
      const child = run(process.execPath, [runner, "--handoff-file", file], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stderr = "";
      child.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.stdout?.resume();
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() :
        reject(Error("Mac Shortcut handoff failed (exit " + code + "): " + stderr)));
    });
    // An exit code is an attempted browser submission, not proof of delivery.
    return "HANDOFF_ATTEMPTED:" + handoff.handoffId;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 20000) throw Error("Review handoff exceeds limit");
  }
  const result = await runReviewHandoff(JSON.parse(raw));
  process.stdout.write(result + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
