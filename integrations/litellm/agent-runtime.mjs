// LiteLLM Proxy adapter for the existing LinearBridge development tool layer.
// Uses the OpenAI-compatible Chat Completions interface exposed by LiteLLM.
// All model-selected tools execute in the unprivileged development process.
const DEFAULT_ENDPOINT = "http://127.0.0.1:4000/v1";
export function validateLiteLLMConfig({ baseUrl = DEFAULT_ENDPOINT, model, apiKey }) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.port === "0" ||
      !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw Error("LiteLLM must use a loopback HTTP proxy with /v1 API prefix");
  }
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(model)) {
    throw Error("Invalid LiteLLM model alias");
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw Error("Missing LiteLLM virtual API key");
  }
  return { url: new URL("/v1/chat/completions", url.origin), model };
}

function parseToolArgs(raw) {
  if (typeof raw !== "string" || raw.length > 310000) throw Error("Invalid LiteLLM tool arguments");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Invalid LiteLLM tool arguments");
  return parsed;
}

export async function runLiteLLMAgent({
  baseUrl = DEFAULT_ENDPOINT, apiKey, model, input, instructions,
  tools = [], maxSteps = 12, onStatus = async () => {},
  fetchImpl = fetch, timeoutMs = 45000,
}) {
  const config = validateLiteLLMConfig({ baseUrl, model, apiKey });
  if (typeof input !== "string" || !input.trim() || input.length > 12000 ||
      typeof instructions !== "string" || instructions.length > 10000) throw Error("Invalid LiteLLM prompt");
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 24) throw Error("Invalid LiteLLM step limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw Error("Invalid LiteLLM timeout");
  const lookup = new Map(tools.map(t => [t.name, t]));
  if (lookup.size !== tools.length || tools.some(t => !t.name || typeof t.execute !== "function" || !t.parameters)) {
    throw Error("Invalid LiteLLM tools");
  }
  const messages = [
    { role: "system", content: instructions },
    { role: "user", content: input },
  ];
  await onStatus("LiteLLM task started");
  for (let step = 0; step < maxSteps; step++) {
    const request = {
      model: config.model, messages, stream: false,
      ...(tools.length ? { tools: tools.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })), tool_choice: "auto" } : {}),
    };
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Error("LiteLLM request failed (HTTP " + response.status + ")");
    const result = await response.json();
    const choice = result?.choices?.[0];
    if (!choice?.message || typeof choice.message !== "object") throw Error("LiteLLM response missing message");
    const message = choice.message;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      if (choice.finish_reason === "length") throw Error("LiteLLM exhausted response tokens");
      const text = message.content;
      if (typeof text !== "string" || !text.trim()) throw Error("LiteLLM returned no final response");
      await onStatus("LiteLLM task completed");
      return { model: config.model, text: text.slice(0, 12000) };
    }
    if (message.tool_calls.length > 12) throw Error("Too many LiteLLM tool calls");
    messages.push({
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      tool_calls: message.tool_calls,
    });
    for (const call of message.tool_calls) {
      const definition = lookup.get(call?.function?.name);
      if (!definition || call.type !== "function" || typeof call.id !== "string" || !call.id) {
        throw Error("LiteLLM called an unavailable tool");
      }
      const args = parseToolArgs(call.function.arguments);
      let output;
      try {
        output = await definition.execute(args);
      } catch (error) {
        output = { error: "Tool rejected the operation" };
      }
      const serialized = typeof output === "string" ? output : JSON.stringify(output);
      messages.push({
        role: "tool", tool_call_id: call.id,
        content: serialized.slice(0, 200000),
      });
      await onStatus("LiteLLM executed " + definition.name);
    }
  }
  throw Error("LiteLLM exhausted its agent step budget");
}

export const LITELLM_DEFAULT_BASE_URL = DEFAULT_ENDPOINT;
