import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createActiveTaskMemory } from "./active-task-memory.mjs";
import { withLocalAgentCheckpoint } from "./local-agent-checkpoint.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-lifecycle-"));
  try {
    const memory = createActiveTaskMemory(root);
    const records = new Map([["job1", { repositoryRoot: "repo", issueId: "ABR-57" }]]);
    const jobStore = {
      get: async key => records.get(key),
      transition: async (key, state, fields = {}) => {
        const next = { ...records.get(key), ...fields, state };
        records.set(key, next);
        return next;
      },
    };
    await memory.update("repo", "ABR-57", { lastJobKey: "job1", lastAgent: "chatgpt-cli" });
    await run({ memory, records, jobStore, scoped: withLocalAgentCheckpoint({ jobStore, memory, jobKey: "job1", agent: "chatgpt-cli" }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("local dispatch transitions persist safe recovery status", async () => fixture(async ({ memory, scoped }) => {
  await scoped.transition("job1", "launching");
  await scoped.transition("job1", "running", { pid: 123 });
  const running = await memory.read("repo", "ABR-57");
  assert.equal(running.state, "active");
  assert.match(running.nextAction, /verify its session/);
  await scoped.transition("job1", "awaiting_external");
  // Persistence across instances is independently covered by active-task-memory tests.
  const pending = await memory.read("repo", "ABR-57");
  assert.equal(pending.state, "needs-recovery");
  assert.match(pending.nextAction, /do not assume completion/i);
  assert.doesNotMatch(memory.recoveryPreamble(pending), /Bearer secret/);
}));

test("late job completion cannot overwrite a newer issue checkpoint", async () => fixture(async ({ memory, scoped }) => {
  await memory.update("repo", "ABR-57", { lastJobKey: "job2", nextAction: "New session" });
  await scoped.transition("job1", "completed");
  const current = await memory.read("repo", "ABR-57");
  assert.equal(current.lastJobKey, "job2");
  assert.equal(current.nextAction, "New session");
}));

test("failed ledger transition cannot create false checkpoint success", async () => fixture(async ({ memory, jobStore }) => {
  jobStore.transition = async () => { throw Error("ledger failed"); };
  const scoped = withLocalAgentCheckpoint({ jobStore, memory, jobKey: "job1", agent: "gemma" });
  await assert.rejects(scoped.transition("job1", "completed"), /ledger failed/);
  assert.equal((await memory.read("repo", "ABR-57")).state, "active");
}));

test("terminal states distinguish completion from verified task success", async () => fixture(async ({ memory, scoped }) => {
  await scoped.transition("job1", "completed");
  const result = await memory.read("repo", "ABR-57");
  assert.equal(result.state, "agent-finished");
  assert.match(result.lastVerifiedResult, /not independently verified/);
  assert.match(result.nextAction, /verify tests/);
}));
