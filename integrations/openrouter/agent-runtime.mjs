// Shared OpenRouter Agent SDK runner. No model or Linear identity is implied here.
// SDK dependencies are deliberately loaded only when this adapter executes.
export async function loadOpenRouterAgentSdk() {
  const [{ OpenRouter, tool }, { stepCountIs }, { z }] = await Promise.all([
    import("@openrouter/agent"),
    import("@openrouter/agent/stop-conditions"),
    import("zod"),
  ]);
  return { OpenRouter, tool, stepCountIs, z };
}

export async function runOpenRouterAgent({
  apiKey, model, input, instructions, tools = [], maxSteps = 6,
  sdk = null, onStatus = async () => {},
}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw Error("OpenRouter credentials are not configured");
  if (typeof model !== "string" || !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.:-]*$/i.test(model)) {
    throw Error("Invalid OpenRouter model identifier");
  }
  if (typeof input !== "string" || !input.trim() || input.length > 12000) throw Error("Invalid agent input");
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) throw Error("Invalid agent step limit");
  const runtime = sdk ?? await loadOpenRouterAgentSdk();
  if (!runtime.OpenRouter || !runtime.stepCountIs) throw Error("OpenRouter SDK is unavailable");
  const client = new runtime.OpenRouter({ apiKey });
  await onStatus("OpenRouter evaluation started");
  const result = client.callModel({
    model, input, instructions, tools, stopWhen: [runtime.stepCountIs(maxSteps)],
  });
  const response = await result.getText();
  if (typeof response !== "string" || !response.trim()) throw Error("OpenRouter returned no final text");
  await onStatus("OpenRouter evaluation completed");
  return { model, text: response };
}
