import { recordResumedConversation } from "../conversations/agy-conversation-state.mjs";
import { recordResumedConversation as legacyRecordResumedConversation } from "../linear-agent-bridge/agy-conversation-state.mjs";
import { createSessionQueue } from "../conversations/agy-session-queue.mjs";
import { createSessionQueue as legacyCreateSessionQueue } from "../linear-agent-bridge/agy-session-queue.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chooseExecutionHost, configuredProjectRoots, makeRemoteRoute, validateSshSettings } from "../routing/host-routing.mjs";
import * as legacyRouting from "../linear-agent-bridge/host-routing.mjs";
import { createOrderedProgressQueue } from "../jobs/ordered-progress.mjs";
import { createOrderedProgressQueue as legacyOrderedProgressQueue } from "../linear-agent-bridge/ordered-progress.mjs";
import { createJobStore } from "../jobs/job-store.mjs";
import { createJobStore as legacyCreateJobStore } from "../linear-agent-bridge/job-store.mjs";
import os from "node:os";
import path from "node:path";

test("P4 routing module is same function identity through legacy bridge entrypoint", () => {
  for (const [name,fn] of Object.entries({ chooseExecutionHost, configuredProjectRoots, makeRemoteRoute, validateSshSettings })) {
    assert.equal(legacyRouting[name], fn, "old and new " + name + " must have one implementation");
  }
  assert.deepEqual(chooseExecutionHost({}), {ok:true,host:"bridge-server",source:"default"});
  assert.equal(chooseExecutionHost({agentLocation:"Macos"}).host,"macos");
  assert.throws(() => makeRemoteRoute({root:"/Users/rebel",repository:"REVREBEL/linear-agents",scope:"../../secrets"}),/escapes/);
});
test("P4 queue module is same function identity and preserves ordered failure recovery", async () => {
  assert.equal(legacyOrderedProgressQueue, createOrderedProgressQueue);
  const queue = createOrderedProgressQueue(), seen = [];
  const first = queue.enqueue(async () => {seen.push(1);throw Error("failed checkpoint");});
  const second = queue.enqueue(async () => {seen.push(2);});
  await assert.rejects(first,/failed checkpoint/);
  await second;
  await queue.drain();
  assert.deepEqual(seen,[1,2]);
});
test("P4 uses canonical modules without relocating live job storage", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(src,/from "\.\.\/routing\/host-routing\.mjs"/);
  assert.match(src,/from "\.\.\/jobs\/ordered-progress\.mjs"/);
  assert.match(src,/from "\.\.\/jobs\/job-store\.mjs"/);
  assert.match(src,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(src,/createJobStore\(JOBS_DIR\)/);
});

test("P4 canonical ledger preserves legacy function identity and persisted records", async () => {
  const fs = await import("node:fs/promises");
  assert.equal(legacyCreateJobStore, createJobStore);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-ledger-"));
  try {
    const current = createJobStore(root);
    const claimed = await current.claim("delivery-123",{ issueId: "ABR-28" });
    assert.equal(claimed.created,true);
    const viaLegacy = legacyCreateJobStore(root);
    const duplicate = await viaLegacy.claim("delivery-123",{ issueId:"different" });
    assert.equal(duplicate.created,false);
    assert.equal(duplicate.record.issueId,"ABR-28");
    await viaLegacy.transition("delivery-123","completed",{ verification:"preserved" });
    const replay = await current.findByIssueId("ABR-28");
    assert.equal(replay.length,1);
    assert.equal(replay[0].state,"completed");
    assert.equal(replay[0].verification,"preserved");
    const entries = await fs.readdir(path.join(root,"job-state"));
    assert.equal(entries.length,1);
  } finally {
    await fs.rm(root,{ recursive:true,force:true });
  }
});

test("P4 conversation resume updates the existing ledger with unchanged metadata", async () => {
  const fs = await import("node:fs/promises");
  assert.equal(recordResumedConversation, legacyRecordResumedConversation);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-resume-"));
  try {
    const ledger = createJobStore(root);
    await ledger.claim("linear:session:1", { issueId:"ABR-28", conversationVerifiedAt:"2026-11-12T00:00:00.000Z" });
    const updated = await legacyRecordResumedConversation(ledger,"linear:session:1","agy-session-xyz");
    assert.equal(updated.state,"launching");
    assert.equal(updated.conversationId,"agy-session-xyz");
    assert.equal(updated.resumedConversationId,"agy-session-xyz");
    assert.equal(updated.conversationSource,"follow_up");
    assert.equal(updated.conversationVerifiedAt,"2026-11-12T00:00:00.000Z");
    assert.ok(!Number.isNaN(Date.parse(updated.resumeRequestedAt)));
    const persisted = (await createJobStore(root).findByIssueId("ABR-28"))[0];
    assert.deepEqual(persisted,updated);
    assert.equal(await recordResumedConversation(ledger,"linear:session:1",""),null);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test("P4 session queue keeps same-session order while allowing distinct sessions", async () => {
  assert.equal(createSessionQueue,legacyCreateSessionQueue);
  const queue=createSessionQueue(),events=[];
  let unlock;
  const gate=new Promise(resolve => { unlock=resolve; });
  const first=queue.enqueue("linear:one",async () => { events.push("one-start");await gate;events.push("one-end"); });
  const second=queue.enqueue("linear:one",async () => { events.push("one-second"); });
  const other=queue.enqueue("linear:two",async () => { events.push("two");unlock(); });
  await Promise.all([first,second,other]);
  assert.deepEqual(events,["one-start","two","one-end","one-second"]);
  await assert.rejects(queue.enqueue("",async () => {}),/Missing Linear Agent Session ID/);
  await assert.rejects(queue.enqueue("linear:failed",async () => {throw Error("interrupted");}),/interrupted/);
  assert.equal(await queue.enqueue("linear:failed",async () => "resumed"),"resumed");
});
test("P4 bridge uses canonical conversation modules without changing state location", async () => {
  const fs=await import("node:fs/promises");
  const src=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(src,/from "\.\.\/conversations\/agy-conversation-state\.mjs"/);
  assert.match(src,/from "\.\.\/conversations\/agy-session-queue\.mjs"/);
  assert.match(src,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
});
