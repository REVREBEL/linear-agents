import { matchesHost } from "./http-helpers.mjs";

/**
 * Preserve the bridge's ordered host-to-agent dispatch rules. The order is
 * significant when a wildcard suffix could match multiple configured hosts.
 * Configured host values are supplied by the original server entrypoint.
 */
export function createAgentHostResolver({
  mockHost, antigravityHost, chatgptHost, chatgptCliHost,
  traeHost, geminiHost, gemmaHost,
}) {
  return function agentForHost(host) {
    if (matchesHost(host, mockHost)) return "mock";
    if (matchesHost(host, antigravityHost)) return "antigravity";
    if (matchesHost(host, chatgptHost)) return "chatgpt";
    if (matchesHost(host, chatgptCliHost)) return "chatgpt-cli";
    if (matchesHost(host, traeHost)) return "trae";
    if (matchesHost(host, geminiHost)) return "gemini";
    if (matchesHost(host, gemmaHost)) return "gemma";
    return "unknown";
  };
}
