import test from "node:test";
import assert from "node:assert/strict";
import { createAgentHostResolver } from "../bridge/agent-host-resolver.mjs";
import { normalizeHost } from "../bridge/http-helpers.mjs";

const config = {
  mockHost: "mock-agent.example.test",
  antigravityHost: "antigravity-agent.example.test",
  chatgptHost: "chatgpt-agent.example.test",
  chatgptCliHost: "chatgpt-cli-agent.example.test",
  traeHost: "trae-agent.example.test",
  geminiHost: "gemini-agent.example.test",
  gemmaHost: "gemma-agent.example.test",
};

test("hostname selection preserves all seven agent identities", () => {
  const resolve = createAgentHostResolver(config);
  for (const [host, expected] of [
    ["mock-agent.example.test", "mock"],
    ["antigravity-agent.example.test", "antigravity"],
    ["chatgpt-agent.example.test", "chatgpt"],
    ["chatgpt-cli-agent.example.test", "chatgpt-cli"],
    ["trae-agent.example.test", "trae"],
    ["gemini-agent.example.test", "gemini"],
    ["gemma-agent.example.test", "gemma"],
    ["other.example.test", "unknown"],
  ]) {
    assert.equal(resolve(host), expected, host);
  }
});

test("host matching accepts only exact hosts and existing dot-delimited subdomains", () => {
  const resolve = createAgentHostResolver(config);
  assert.equal(resolve("nested.trae-agent.example.test"), "trae");
  assert.equal(resolve("faketrae-agent.example.test"), "unknown");
  assert.equal(resolve("trae-agent.example.test.evil"), "unknown");
  assert.equal(resolve(normalizeHost("TRAE-AGENT.EXAMPLE.TEST:8788")), "trae");
});

test("hostname selection retains ordered first-match precedence", () => {
  const resolve = createAgentHostResolver({
    ...config,
    mockHost: "example.test",
    antigravityHost: "special.example.test",
  });
  assert.equal(resolve("special.example.test"), "mock");
});

test("resolver reads supplied deployment config rather than environment globals", () => {
  const resolve = createAgentHostResolver({ ...config, traeHost: "new-trae.local" });
  assert.equal(resolve("new-trae.local"), "trae");
  assert.equal(resolve("trae-agent.example.test"), "unknown");
});

test("bridge calls the extracted resolver without moving its listener or runtime ledger", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs", import.meta.url), "utf8");
  assert.match(src, /from "\.\.\/bridge\/agent-host-resolver\.mjs"/);
  assert.match(src, /const agentForHost = createAgentHostResolver\(\{/);
  // Verify the resolver is actually consumed by both diagnostics and job routing.
  assert.match(src, /const handleDiagnosticRoute = createDiagnosticRoutes\(\{\s*sharedSecret: SHARED_SECRET,\s*agentForHost,/);
  assert.match(src, /const agent = agentForHost\(host\);/);
  assert.match(src, /const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(src, /const server = http\.createServer\(/);
  assert.match(src, /server\.listen\(PORT, HOST, \(\) => \{/);
});
