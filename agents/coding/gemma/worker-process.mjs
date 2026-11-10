#!/usr/bin/env node
// Dedicated, unprivileged development process. stdin receives the task, not credentials.
// The process must be started by the bridge as the restricted 'rebel' OS user.
import fs from "node:fs/promises";
import { runGemmaDevelopment } from "./dev-runner.mjs";
async function main() {
  if (process.getuid?.() === 0 || process.env.USER !== "rebel" || process.env.HOME !== "/home/rebel") {
    throw Error("Gemma runner requires restricted rebel account");
  }
  const keyFile = "/home/rebel/.config/linearbridge/openrouter.key";
  const stat = await fs.stat(keyFile);
  if ((stat.mode & 0o077) !== 0 || !stat.isFile() || stat.uid !== process.getuid()) {
    throw Error("Gemma key file must be owned by rebel and readable only by its owner");
  }
  const apiKey = (await fs.readFile(keyFile, "utf8")).trim();
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 15000) throw Error("Job input too large");
  }
  const job = JSON.parse(raw);
  if (typeof job.prompt !== "string" || typeof job.workspace !== "string") throw Error("Invalid job");
  const result = await runGemmaDevelopment({
    workspace: job.workspace,
    prompt: job.prompt,
    apiKey,
    onStatus: async message => {
      process.stdout.write(JSON.stringify({ type: "status", message: String(message).slice(0, 500) }) + "\n");
    },
  });
  process.stdout.write(JSON.stringify({ type: "done", text: result.text.slice(0, 3500) }) + "\n");
}
main().catch(() => {
  // Never print model error objects: they may contain prompts and credentials.
  process.stdout.write(JSON.stringify({ type: "error", message: "Gemma execution failed" }) + "\n");
  process.exitCode = 1;
});
