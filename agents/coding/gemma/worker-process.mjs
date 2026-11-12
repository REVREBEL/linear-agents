#!/usr/bin/env node
// Unprivileged development agent process. Never inherit bridge secrets.
// Provider choice is supplied by the authenticated bridge; keys live outside Git.
import { loadGemmaProviderKey } from "./provider-key.mjs";
import { runGemmaDevelopment } from "./dev-runner.mjs";
import { validateLiteLLMConfig } from "../../../integrations/litellm/agent-runtime.mjs";

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
  // The local LiteLLM proxy uses OPENROUTER_API_KEY upstream in its own process.
  // Unless proxy authentication is enabled, the SDK only needs a non-secret
  // placeholder for its required apiKey option. Do not forward the upstream key.
  const apiKey = provider === "litellm"
    ? "local-litellm-no-client-auth"
    : await loadGemmaProviderKey("openrouter");
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
