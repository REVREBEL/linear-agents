import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { launchMacTrae } from "./ssh-dispatch.mjs";

test("SSH stdin EPIPE rejects dispatch without uncaught process error", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    queueMicrotask(() => child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  };
  child.kill = () => {};
  const changes = [];
  const jobStore = { async transition(key, state, updates) { changes.push({ key, state, updates }); } };
  await assert.rejects(
    launchMacTrae({
      job: { jobId: "test-delivery" },
      jobKey: "trae:delivery",
      jobStore,
      spawnImpl: () => child,
      env: { MAC_SSH_HOST: "macos", OSX_PROJECTS_ROOT: "/Users/test/rebel" },
      log: { log() {}, error() {} },
    }), /broken pipe/
  );
  // The failure is a recorded transport failure, never an unhandled stream error.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(changes.some(change => change.state === "failed"));
});
