#!/usr/bin/env node
// Unprivileged development agent process. Never inherit bridge secrets.
// Provider choice is supplied by the authenticated bridge; keys live outside Git.
import fs from "node:fs/promises";
import { runGemmaDevelopment } from "./dev-runner.mjs";
import { validateLiteLLMConfig } from "../../../integrations/litellm/agent-runtime.mjs";

async function readKey(provider) {
  const keyFile = provider === "litellm"
    ? "/home/rebel/.config/linearbridge/litellm.key"
    : "/home/rebel/.config/linearbridge/openrouter.key";
  const stat = await fs.lstat(keyFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw Error("Provider key file must be owned by rebel and readable only by its owner");
  }
  const key = (await fs.readFile(keyFile, "utf8")).trim();
  if (!key) throw Error("Provider key file is empty");
  return key;
}
async function main() {
  if (process.getuid?.() === 0 || process.env.USER !== "rebel" || process.env.HOME !== "/home/rebel") {
    throw Error("Gemma runner requires restricted rebel account");
  }
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 16000) throw Error("Job input too large");
  }
  const job = JSON.parse(raw);
  if (typeof job.prompt !== "string" || typeof job.workspace !== "string") throw Error("Invalid job");
  const provider = job.provider === "litellm" ? "litellm" : job.provider === "openrouter" ? "openrouter" : null;
  if (!provider) throw Error("Unknown execution provider");
  if (provider === "litellm") {
    // Reject remote endpoints before ever loading the proxy credential.
    validateLiteLLMConfig({ baseUrl: job.baseUrl, model: job.model, apiKey: "validation-only" });
  }
  const apiKey = await readKey(provider);
  const result = await runGemmaDevelopment({
    workspace: job.workspace, prompt: job.prompt, provider, model: job.model,
    liteLLMBaseUrl: job.baseUrl, apiKey,
    onStatus: async message => {
      process.stdout.write(JSON.stringify({ type: "status", message: String(message).slice(0, 500) }) + "\n");
    },
  });
  process.stdout.write(JSON.stringify({ type: "done", text: result.text.slice(0, 3500) }) + "\n");
}
main().catch(() => {
  // Never print model errors, responses or key files.
  process.stdout.write(JSON.stringify({ type: "error", message: "Gemma execution failed" }) + "\n");
  process.exitCode = 1;
});
