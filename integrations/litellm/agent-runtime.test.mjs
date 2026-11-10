import test from "node:test";
import assert from "node:assert/strict";
import { makeLiteLLMDevelopmentTools } from "../../agents/coding/gemma/litellm-tools.mjs";
import { runLiteLLMAgent, validateLiteLLMConfig } from "./agent-runtime.mjs";

const response = (message, finish_reason = "stop") => ({ choices: [{ message, finish_reason }] });
const sdk = handler => options => ({
  chat: { completions: { create: request => handler(request, options) } },
});

test("LiteLLM uses official SDK client and executes approved move tool", async () => {
  const moves = [], requests = [], optionsSeen = [], progress = [];
  const tools = makeLiteLLMDevelopmentTools({
    list: async () => [], read: async () => "",
    write: async () => "", move: async (from, to) => { moves.push([from, to]); return "moved"; },
    remove: async () => "", runTest: async () => "passed", gitStatus: async () => "",
    gitDiff: async () => "", commit: async () => "",
  });
  const clientFactory = sdk(async (request, options) => {
    requests.push(request);
    optionsSeen.push(options);
    return requests.length === 1
      ? response({ role: "assistant", content: null, tool_calls: [{
          id: "c1", type: "function", function: {
            name: "move_path",
            arguments: JSON.stringify({ source: "old", destination: "agents/coding/gemma/old" }),
          },
        }] }, "tool_calls")
      : response({ role: "assistant", content: "Moved files." });
  });
  const result = await runLiteLLMAgent({
    apiKey: "test-only", model: "gemma", input: "Reorganize folders",
    instructions: "Inspect repository", tools, clientFactory,
    onStatus: async message => progress.push(message),
  });
  assert.equal(result.text, "Moved files.");
  assert.deepEqual(moves, [["old", "agents/coding/gemma/old"]]);
  assert.equal(optionsSeen[0].baseURL, "http://127.0.0.1:4000/v1");
  assert.equal(optionsSeen[0].apiKey, "test-only");
  assert.equal(optionsSeen[0].maxRetries, 0);
  assert.equal(requests[0].model, "gemma");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "c1");
  assert.ok(progress.includes("LiteLLM executed move_path"));
});
test("LiteLLM rejects remote endpoints and unavailable model tools", async () => {
  for (const baseUrl of [
    "https://example.org/v1", "http://192.168.8.105:4000/v1",
    "http://user:pass@localhost:4000/v1", "http://localhost:4000/custom",
    "http://localhost:4000/v1?x=1",
  ]) {
    assert.throws(() => validateLiteLLMConfig({ baseUrl, apiKey: "test", model: "gemma" }));
  }
  assert.equal(validateLiteLLMConfig({
    baseUrl: "http://localhost:4000/v1", apiKey: "test", model: "gemma",
  }).baseURL, "http://localhost:4000/v1");
  await assert.rejects(runLiteLLMAgent({
    apiKey: "test", model: "gemma", input: "Deploy", instructions: "Test",
    clientFactory: sdk(async () => response({
      role: "assistant", tool_calls: [{
        type: "function", id: "t1", function: { name: "deploy", arguments: "{}" },
      }],
    }, "tool_calls")),
  }), /unavailable tool/);
});
test("LiteLLM handles rate limits and step exhaustion", async () => {
  await assert.rejects(runLiteLLMAgent({
    apiKey: "test", model: "gemma", input: "test", instructions: "test",
    clientFactory: sdk(async () => {
      const error = new Error("LiteLLM HTTP 429");
      error.status = 429;
      throw error;
    }),
  }), /429/);
  await assert.rejects(runLiteLLMAgent({
    apiKey: "test", model: "gemma", input: "test", instructions: "test",
    maxSteps: 1,
    clientFactory: sdk(async () => response({
      role: "assistant", content: null, tool_calls: [{
        type: "function", id: "t2", function: { name: "git_status", arguments: "{}" },
      }],
    }, "tool_calls")),
    tools: [{ name: "git_status", description: "Git status", parameters: { type: "object" }, execute: async () => "ok" }],
  }), /step budget/);
});
