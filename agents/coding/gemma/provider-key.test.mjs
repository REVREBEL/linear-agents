import test from "node:test";
import assert from "node:assert/strict";
import { loadGemmaProviderKey } from "./provider-key.mjs";

test("OpenRouter credential is scoped to a minimal environment", async () => {
  const seen = [];
  const key = await loadGemmaProviderKey("openrouter", {
    execFile: async (binary, args, options) => {
      seen.push({ binary, args, options });
      return { stdout: "test-openrouter-credential", stderr: "" };
    },
  });
  assert.equal(key, "test-openrouter-credential");
  const [{ binary, args, options }] = seen;
  assert.equal(binary, "/usr/bin/zsh");
  assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LOGNAME", "PATH", "USER"]);
  assert.equal(options.env.USER, "rebel");
  assert.equal(options.env.HOME, "/home/rebel");
  assert.match(args[1], /load_op_env/);
  assert.match(args[1], /OPENROUTER_API_KEY/);
  assert.doesNotMatch(args[1], /AGENT_BRIDGE_PRIVATE_KEY|MISTRAL_API_KEY|BEAM_API_KEY/);
  assert.equal(options.timeout, 30000);
});

test("unlisted provider cannot invoke shell or read secrets", async () => {
  let called = false;
  await assert.rejects(loadGemmaProviderKey("bridge", {
    execFile: async () => { called = true; return { stdout: "bad" }; },
  }), /Unsupported Gemma credential provider/);
  assert.equal(called, false);
});

test("LiteLLM gets only its dedicated proxy credential", async () => {
  const key = await loadGemmaProviderKey("litellm", {
    execFile: async (_bin, args) => {
      assert.match(args[1], /LITELLM_API_KEY/);
      assert.doesNotMatch(args[1], /OPENROUTER_API_KEY/);
      return { stdout: "litellm-proxy-token" };
    },
  });
  assert.equal(key, "litellm-proxy-token");
});

test("loader failure, empty value and oversized output fail closed", async () => {
  await assert.rejects(loadGemmaProviderKey("openrouter", {
    execFile: async () => { throw Object.assign(Error("secret-in-error"), { stdout: "secret-in-error" }); },
  }), error => !error.message.includes("secret-in-error"));
  await assert.rejects(loadGemmaProviderKey("openrouter", {
    execFile: async () => ({ stdout: "" }),
  }), /unavailable/);
  await assert.rejects(loadGemmaProviderKey("openrouter", {
    execFile: async () => ({ stdout: "A".repeat(8200) }),
  }), /unavailable/);
});
