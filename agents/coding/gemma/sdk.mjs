// Resolve the pinned beta SDK from this package's own node_modules tree.
// The shared runtime receives the resulting SDK object via dependency injection.
export async function loadOpenRouterAgentSdk() {
  const [{ OpenRouter, tool }, { stepCountIs }, { z }] = await Promise.all([
    import("@openrouter/agent"),
    import("@openrouter/agent/stop-conditions"),
    import("zod"),
  ]);
  if (!OpenRouter || !tool || !stepCountIs || !z) throw Error("OpenRouter SDK exports are unavailable");
  return { OpenRouter, tool, stepCountIs, z };
}
