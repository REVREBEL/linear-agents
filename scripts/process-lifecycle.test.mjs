import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createProcessLifecycleReporter } from "../jobs/process-lifecycle.mjs";

function harness({ rejectTransition = false } = {}) {
  const transitions = [], output = [], errors = [];
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const logger = {
    log: message => output.push(message),
    error: message => errors.push(message),
  };
  const jobStore = {
    async transition(...args) {
      transitions.push(args);
      if (rejectTransition) throw Error("ledger unavailable");
    },
  };
  return {
    child, transitions, output, errors, logger, jobStore,
    attach: createProcessLifecycleReporter({ jobStore, logger }),
    flush: () => new Promise(resolve => setImmediate(resolve)),
  };
}

test("process lifecycle records running and completed, preserving stdout and stderr", async () => {
  const h = harness();
  h.attach(h.child, "Gemini", "gemini:1");
  h.child.emit("spawn");
  h.child.stdout.write("done\n");
  h.child.stderr.write("notice\n");
  h.child.emit("close", 0, null);
  await h.flush();
  assert.deepEqual(h.transitions, [
    ["gemini:1", "running", { pid: 1234 }],
    ["gemini:1", "completed", { exitCode: 0, signal: null }],
  ]);
  assert.deepEqual(h.output, ["[Gemini-Out]: done", "[Gemini-Exit]: code=0 signal=none"]);
  assert.deepEqual(h.errors, ["[Gemini-Err]: notice"]);
});

test("process lifecycle keeps external-success as awaiting_external and nonzero exit failed", async () => {
  const h = harness();
  h.attach(h.child, "Trae", "trae:1", true);
  h.child.emit("close", 0, null);
  await h.flush();
  assert.deepEqual(h.transitions, [["trae:1", "awaiting_external", { exitCode: 0, signal: null }]]);
  const failure = harness();
  failure.attach(failure.child, "Trae", "trae:2", true);
  failure.child.emit("close", 7, "SIGTERM");
  await failure.flush();
  assert.deepEqual(failure.transitions, [["trae:2", "failed", { exitCode: 7, signal: "SIGTERM" }]]);
});

test("process spawn error fails once and ignores subsequent close transition", async () => {
  const h = harness();
  h.attach(h.child, "OpenCode", "chatgpt-cli:1");
  h.child.emit("error", Error("ENOENT"));
  h.child.emit("close", null, null);
  await h.flush();
  assert.deepEqual(h.transitions, [["chatgpt-cli:1", "failed", { error: "ENOENT" }]]);
  assert.deepEqual(h.errors, ["[OpenCode-Spawn-Error]: ENOENT"]);
  assert.deepEqual(h.output, ["[OpenCode-Exit]: code=null signal=none"]);
});

test("failed fire-and-forget ledger transitions report error without unhandled rejection", async () => {
  const h = harness({ rejectTransition: true });
  h.attach(h.child, "Gemini", "gemini:2");
  h.child.emit("spawn");
  h.child.emit("close", 1, null);
  await h.flush();
  assert.equal(h.errors.length, 2);
  assert.ok(h.errors.every(error => error instanceof Error && error.message === "ledger unavailable"));
  assert.deepEqual(h.transitions.map(row => row[1]), ["running", "failed"]);
});
