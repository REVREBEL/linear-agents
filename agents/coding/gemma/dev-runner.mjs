import { runOpenRouterAgent } from "../../../integrations/openrouter/agent-runtime.mjs";
import { runLiteLLMAgent } from "../../../integrations/litellm/agent-runtime.mjs";
import OpenAI from "openai";
import { loadOpenRouterAgentSdk } from "./sdk.mjs";
import { createDevOperations, makeGemmaDevTools } from "./dev-tools.mjs";
import { makeLiteLLMDevelopmentTools } from "./litellm-tools.mjs";

export async function runGemmaDevelopment({
  workspace, prompt, apiKey, sdk, onStatus = async () => {},
  provider = "openrouter", model, liteLLMBaseUrl,
}) {
  const ops = await createDevOperations({ workspace });
  const instructions = [
    "You are Gemma, a coding agent on a disposable development checkout.",
    "You may reorganize, create, edit and remove source files, run approved tests, and commit on the task branch.",
    "Do not read or modify secrets, live job state, .git internals, operating-system files, remote services, or other repositories.",
    "Do not claim to push, merge or deploy. Do not run unrestricted shell commands.",
    "Report exactly which edits, tests, and commits you completed and any errors.",
  ].join(" ");
  if (provider === "litellm") {
    return runLiteLLMAgent({
      baseUrl: liteLLMBaseUrl, apiKey, model,
      clientFactory: options => new OpenAI(options),
      input: prompt, instructions,
      tools: makeLiteLLMDevelopmentTools(ops),
      maxSteps: 12, onStatus,
    });
  }
  if (provider !== "openrouter") throw Error("Unknown Gemma execution provider");
  const runtime = sdk ?? await loadOpenRouterAgentSdk();
  return runOpenRouterAgent({
    apiKey, model: "google/gemma-4-31b-it:free",
    input: prompt, sdk: runtime, onStatus, tools: makeGemmaDevTools(ops, runtime),
    maxSteps: 12, instructions,
  });
}
