import test from "node:test";
import assert from "node:assert/strict";
import { makeLiteLLMDevelopmentTools } from "../../agents/coding/gemma/litellm-tools.mjs";
import { runLiteLLMAgent, validateLiteLLMConfig } from "./agent-runtime.mjs";

const response = (message, finish_reason = "stop") => ({
  ok: true, json: async () => ({ choices: [{ message, finish_reason }] }),
});
test("LiteLLM executes the approved move tool and reports completion", async () => {
  const moves = [], requests = [], progress = [];
  const tools = makeLiteLLMDevelopmentTools({
    list: async () => [], read: async () => "",
    write: async () => "", move: async (a, b) => { moves.push([a,b]); return "moved"; },
    remove: async () => "", runTest: async () => "passed", gitStatus: async () => "",
    gitDiff: async () => "", commit: async () => "",
  });
  const clientFactory = options => ({ chat: { completions: { create: async body => {
    requests.push({ options, body });
    return requests.length === 1
      ? response({ role: "assistant", content: null, tool_calls: [{
          id: "c1", type: "function", function: { name: "move_path",
            arguments: JSON.stringify({ source: "old", destination: "agents/coding/gemma/old" }) },
        }] }, "tool_calls")
      : response({ role: "assistant", content: "Moved files." });
  } } } });
  const result = await runLiteLLMAgent({
    apiKey: "test-only", model: "gemma", input: "Reorganize folders", instructions: "Inspect repository",
    tools, clientFactory, onStatus: async x => progress.push(x),
  });
  assert.equal(result.text, "Moved files.");
  assert.deepEqual(moves, [["old", "agents/coding/gemma/old"]]);
  assert.equal(requests[0].options.baseURL, "http://127.0.0.1:4000/v1");
  assert.equal(requests[0].options.apiKey, "test-only");
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, "c1");
  assert.ok(progress.includes("LiteLLM executed move_path"));
});
test("LiteLLM rejects remote proxy URLs and unsafe tool names", async () => {
  for (const baseUrl of ["https://example.org/v1", "http://192.168.8.105:4000/v1",
    "http://user:pass@localhost:4000/v1", "http://localhost:4000/custom",
    "http://localhost:4000/v1?x=1"]) {
    assert.throws(() => validateLiteLLMConfig({ baseUrl, apiKey: "test", model: "gemma" }));
  }
  assert.doesNotThrow(() => validateLiteLLMConfig({ baseUrl: "http://localhost:4000/v1", apiKey: "test", model: "gemma" }));
  await assert.rejects(runLiteLLMAgent({
    apiKey: "test", model: "gemma", input: "Deploy", instructions: "Test",
    clientFactory: () => ({ chat: { completions: { create: async () => response({ role: "assistant", tool_calls: [{
      type: "function", id: "t1", function: { name: "deploy", arguments: "{}" },
    }] }, "tool_calls") } } }),
  }), /unavailable tool/);
});
test("LiteLLM handles rate limits, malformed output, and step exhaustion", async () => {
  await assert.rejects(runLiteLLMAgent({
    apiKey: "test", model: "gemma", input: "test", instructions: "test",
    clientFactory: () => ({ chat: { completions: { create: async () => { const error = new Error("LiteLLM request failed (HTTP 429)"); error.status = 429; throw error; } } } }),
  }), /HTTP 429/);
  await assert.rejects(runLiteLLMAgent({
    apiKey: "test", model: "gemma", input: "test", instructions: "test",
    maxSteps: 1, clientFactory: () => ({ chat: { completions: { create: async () => response({ role: "assistant", content: null, tool_calls: [{
      type: "function", id: "t2", function: { name: "git_status", arguments: "{}" },
    }] }, "tool_calls") } } }),
    tools: [{ name: "git_status", description: "Git status", parameters: { type: "object" }, execute: async () => "ok" }],
  }), /step budget/);
});
