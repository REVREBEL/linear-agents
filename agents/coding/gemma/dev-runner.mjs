import { runOpenRouterAgent } from "../../../integrations/openrouter/agent-runtime.mjs";
import { loadOpenRouterAgentSdk } from "./sdk.mjs";
import { createDevOperations, makeGemmaDevTools } from "./dev-tools.mjs";
export async function runGemmaDevelopment({ workspace, prompt, apiKey, sdk, onStatus = async () => {} }) {
  const runtime = sdk ?? await loadOpenRouterAgentSdk();
  const ops = await createDevOperations({ workspace });
  return runOpenRouterAgent({
    apiKey, model: "google/gemma-4-31b-it:free",
    input: prompt, sdk: runtime, onStatus, tools: makeGemmaDevTools(ops, runtime),
    maxSteps: 12,
    instructions: [
      "You are Gemma, the coding agent on a disposable development checkout.",
      "You may reorganize, create, edit and remove source files, run approved tests, and commit on the task branch.",
      "Do not read or modify secrets, live job state, .git internals, operating-system files, remote services, or other repositories.",
      "Do not claim to push, merge or deploy. Do not run unrestricted shell commands.",
      "Report exactly which edits, tests, and commits you completed and any errors.",
    ].join(" "),
  });
}
