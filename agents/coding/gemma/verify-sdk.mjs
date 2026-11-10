import { loadOpenRouterAgentSdk } from "./sdk.mjs";
const sdk = await loadOpenRouterAgentSdk();
if (typeof sdk.OpenRouter !== "function" || typeof sdk.tool !== "function" ||
    typeof sdk.stepCountIs !== "function" || typeof sdk.z.object !== "function") {
  throw Error("OpenRouter Agent SDK contract mismatch");
}
process.stdout.write("OpenRouter SDK exports verified\n");
