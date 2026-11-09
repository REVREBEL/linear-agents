import test from "node:test";
import assert from "node:assert/strict";
import { buildAntigravityLaunch } from "./agents/antigravity/scripts/launch.mjs";
import { buildGeminiLaunch } from "./agents/gemini/scripts/launch.mjs";

test("Antigravity launcher preserves runner, follow-up ID and credentials boundary", () => {
  const launch = buildAntigravityLaunch({
    pythonBin: "/home/bridge/.venv/bin/python",
    runnerPath: "/home/bridge/linear-agents/linear-agent-bridge/run_agent.py",
    sessionId: "session-1", taskFile: "/tmp/task.json", conversationId: "conversation-1",
    workspace: "/home/bridge/projects/example",
    projectDir: "/home/bridge/linear-agents",
    credential: { variable: "ANTIGRAVITY_LINEAR_API_KEY", accessToken: "app-token" },
    env: { LINEAR_API_KEY: "personal-token", LINEAR_ACCESS_TOKEN: "old-token", BRIDGE_SHARED_SECRET: "bridge-token" },
  });
  assert.equal(launch.command, "/home/bridge/.venv/bin/python");
  assert.deepEqual(launch.args, ["/home/bridge/linear-agents/linear-agent-bridge/run_agent.py", "session-1", "/tmp/task.json", "conversation-1"]);
  assert.equal(launch.options.cwd, "/home/bridge/linear-agents");
  assert.equal(launch.options.env.ANTIGRAVITY_WORKSPACE, "/home/bridge/projects/example");
  assert.equal(launch.options.env.ANTIGRAVITY_LINEAR_API_KEY, "app-token");
  assert.equal("LINEAR_API_KEY" in launch.options.env, false);
  assert.equal("LINEAR_ACCESS_TOKEN" in launch.options.env, false);
  assert.deepEqual(launch.options.stdio, ["ignore", "pipe", "pipe"]);
});

test("Gemini launcher preserves shell-free args, workspace and agent token", () => {
  let passed;
  const launch = buildGeminiLaunch({
    binary: "/home/bridge/.volta/bin/gemini",
    template: "-p {{PROMPT}} --approval-mode auto_edit --skip-trust",
    prompt: "Review 'quoted' issue; do not shell-evaluate",
    taskFile: "/tmp/task.json",
    workspace: "/home/bridge/projects/example",
    credential: { variable: "GEMINI_LINEAR_API_KEY", accessToken: "app-token" },
    buildArgs(...args) { passed = args; return ["-p", args[1], "--approval-mode", "auto_edit", "--skip-trust"]; },
    env: { LINEAR_API_KEY: "personal-token", LINEAR_ACCESS_TOKEN: "old-token" },
  });
  assert.equal(passed[1], "Review 'quoted' issue; do not shell-evaluate");
  assert.equal(launch.command, "/home/bridge/.volta/bin/gemini");
  assert.deepEqual(launch.args.slice(0, 2), ["-p", passed[1]]);
  assert.equal(launch.options.cwd, "/home/bridge/projects/example");
  assert.equal(launch.options.env.LINEAR_API_KEY, "");
  assert.equal(launch.options.env.GEMINI_LINEAR_API_KEY, "app-token");
});
