import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAgentSessionId, extractDirectTask, extractPromptContext,
  firstString, buildGenericArgs, shellLikeSplit, shellQuote, maskArg,
} from "../bridge/prompt-arguments.mjs";

test("prompt utilities preserve Linear agent-session precedence and trims", () => {
  const job = {
    agentSessionId: "  explicit-session  ",
    payload: { data: { agentSessionId: "secondary", promptContext: "  Do the task  " } },
  };
  assert.equal(extractAgentSessionId(job), "explicit-session");
  assert.equal(extractPromptContext(job), "Do the task");
  assert.equal(extractAgentSessionId({ payload: { original: { data: { id: "old-session" } } } }), "old-session");
  assert.equal(extractPromptContext({ payload: { original: { data: { agentSession: { promptContext: "nested" } } } } }), "nested");
  assert.equal(extractAgentSessionId({}), undefined);
  assert.equal(firstString([null, "  ", " accepted ", "ignored"]), "accepted");
});

test("direct-task extraction preserves description and optional non-generic request", () => {
  const message = [
    "Untrusted wrapper",
    '<issue identifier="ABR-28"><title>Refactor</title><description>Keep the callback token.\nDo not rotate secrets.</description></issue>',
    "<user-request>Check the routing rules</user-request>",
    "Extra commentary",
  ].join("\n");
  assert.equal(extractDirectTask(message), [
    "Issue: ABR-28", "Title: Refactor", "",
    "Keep the callback token.\nDo not rotate secrets.", "", "Request:", "Check the routing rules",
  ].join("\n"));
  assert.equal(extractDirectTask("Just do the task"), "Just do the task");
  assert.equal(extractDirectTask(""), undefined);
  assert.ok(!extractDirectTask(message.replace("Check the routing rules", "Work on ABR-28")).includes("Request:"));
});

test("CLI argument expansion is exact for quoted templates and embedded spaces", () => {
  assert.deepEqual(
    buildGenericArgs('--prompt "{{PROMPT}}" --file={{JOB_FILE}} --cwd={{WORKSPACE}}',
      "a task with spaces", "/tmp/task file.json", "/repo root"),
    ["--prompt", "a task with spaces", "--file=/tmp/task file.json", "--cwd=/repo root"],
  );
  assert.deepEqual(shellLikeSplit('run "hello world" test\\ arg'), ["run", "hello world", "test arg"]);
  assert.equal(shellQuote("Gary's folder"), "'Gary'\\''s folder'");
  assert.equal(maskArg("a".repeat(121)), "a".repeat(120) + "...");
  assert.equal(maskArg("short"), "short");
});
