import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildOpenCodeLaunch, parseOpenCodeEvent, runOpenCode, checkOpenCodeReady, summarizeOpenCodeProgress } from "./agents/chatgpt/scripts/launch.mjs";

test("OpenCode uses existing ChatGPT OAuth identity with no browser or bridge secrets", () => {
  const launch = buildOpenCodeLaunch({
    binary: "/home/opencode/.opencode/bin/opencode",
    model: "openai/gpt-6",
    workspace: "/home/bridge/rebel/linear-agents",
    prompt: "Review this repository",
    sessionId: "ses_abcdef1234",
    env: { BRIDGE_SHARED_SECRET: "secret", LINEAR_API_KEY: "personal", CHATGPT_LINEAR_API_KEY: "app", PATH: "/usr/bin" },
  });
  assert.equal(launch.command, "/home/opencode/.opencode/bin/opencode");
  assert.deepEqual(launch.args, ["run", "--format", "json", "--model", "openai/gpt-6",
    "--session", "ses_abcdef1234", "Review this repository"]);
  assert.equal(launch.options.cwd, "/home/bridge/rebel/linear-agents");
  assert.equal(launch.options.env.BRIDGE_SHARED_SECRET, undefined);
  assert.equal(launch.options.env.LINEAR_API_KEY, undefined);
  assert.equal(launch.options.env.CHATGPT_LINEAR_API_KEY, undefined);
  assert.equal(launch.options.env.PATH, "/usr/bin");
});
test("OpenCode can run under the previously authenticated Ubuntu service account", () => {
  const launch = buildOpenCodeLaunch({
    binary: "/home/opencode/.opencode/bin/opencode", runAsUser: "opencode",
    workspace: "/home/bridge/rebel/linear-agents", prompt: "Check tests",
  });
  assert.equal(launch.command, "/usr/bin/sudo");
  assert.deepEqual(launch.args.slice(0, 6), ["-n", "-H", "-u", "opencode", "--", "/home/opencode/.opencode/bin/opencode"]);
  assert.throws(() => buildOpenCodeLaunch({ binary: "opencode", runAsUser: "root", workspace: "/tmp", prompt: "x" }), /absolute/);
});
test("JSON stream extracts a durable OpenCode session and final assistant text", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const sessions = [];
  const run = runOpenCode({
    launch: buildOpenCodeLaunch({ workspace: "/tmp/repo", prompt: "Check tests" }),
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(
          JSON.stringify({ type: "text", sessionID: "ses_abc123", part: { text: "Tests passed" } }) + "\n"));
        child.emit("close", 0);
      });
      return child;
    },
    onSession: async id => sessions.push(id),
  });
  assert.deepEqual(await run, { sessionId: "ses_abc123", exitCode: 0, summary: "Tests passed" });
  assert.deepEqual(sessions, ["ses_abc123"]);
});
test("no text or error events cannot be misreported as completed", async () => {
  for (const output of [
    JSON.stringify({ type: "step_start", sessionID: "ses_abc" }) + "\n",
    JSON.stringify({ type: "error", sessionID: "ses_abc" }) + "\n",
  ]) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    await assert.rejects(() => runOpenCode({
      launch: buildOpenCodeLaunch({ workspace: "/tmp/repo", prompt: "Check tests" }),
      spawnImpl: () => {
        queueMicrotask(() => { child.stdout.emit("data", output); child.emit("close", 0); });
        return child;
      }
    }), /completion unverified|execution failed/);
  }
});

test("preflight rejects local Ollama defaults and missing OpenCode config", async () => {
  const exists = { async access() {} };
  await assert.rejects(() => checkOpenCodeReady({
    binary: "/home/opencode/.opencode/bin/opencode", model: "ollama/qwen3.5",
    fsApi: exists,
  }), /openai/);
  await assert.rejects(() => checkOpenCodeReady({
    binary: "", model: "openai/gpt-6", fsApi: exists,
  }), /OPENCODE_BIN/);
  assert.equal(await checkOpenCodeReady({
    binary: "/home/opencode/.opencode/bin/opencode", model: "openai/gpt-6",
    runAsUser: "opencode", fsApi: exists,
  }), true);
});

test("CLI progress is filtered and delivered in order without tool inputs", async () => {
  assert.equal(summarizeOpenCodeProgress("text"), null);
  assert.equal(summarizeOpenCodeProgress("reasoning"), null);
  assert.equal(summarizeOpenCodeProgress("tool_use"), "ChatGPT CLI is working in the repository.");
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const events = [];
  const result = runOpenCode({
    launch: buildOpenCodeLaunch({ workspace: "/tmp/repo", prompt: "Implement issue" }),
    spawnImpl: () => {
      queueMicrotask(() => {
        for (const data of [
          {type:"step_start",sessionID:"ses_test123"},
          {type:"tool_use",sessionID:"ses_test123",part:{tool:"bash",state:{input:{command:"PRIVATE_TOKEN=secret"},output:"hidden"}}},
          {type:"step_finish",sessionID:"ses_test123"},
          {type:"text",sessionID:"ses_test123",part:{text:"Implementation complete"}},
        ]) child.stdout.emit("data", JSON.stringify(data) + "\n");
        child.emit("close", 0);
      });
      return child;
    },
    onProgress: async summary => events.push(summary),
  });
  await result;
  assert.equal(events.length, 3);
  assert.equal(JSON.stringify(events).includes("PRIVATE_TOKEN"), false);
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.ok(events[0].includes("analyzing"));
  assert.ok(events[2].includes("completed an implementation step"));
});
