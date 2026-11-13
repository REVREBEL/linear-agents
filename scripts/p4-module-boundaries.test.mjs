import { createReviewInbox } from "../bridge/review-inbox.mjs";
import { createReviewInbox as legacyCreateReviewInbox } from "../linear-agent-bridge/review-inbox.mjs";
import * as githubIntegration from "../integrations/github-events.mjs";
import * as legacyGithubIntegration from "../linear-agent-bridge/github-events.mjs";
import { createGithubTaskMemory } from "../memory/github-task-memory.mjs";
import { createGithubTaskMemory as legacyGithubTaskMemory } from "../linear-agent-bridge/github-task-memory.mjs";
import { createActiveTaskMemory, sanitizeCheckpoint, sanitizeCheckpointText, isCheckpointExpired } from "../memory/active-task-memory.mjs";
import * as legacyActiveMemory from "../linear-agent-bridge/active-task-memory.mjs";
import { compactRecall, retrieveMemuMemory } from "../memory/memu-memory.mjs";
import * as legacyMemuMemory from "../linear-agent-bridge/memu-memory.mjs";
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

test("P4 memory imports share one implementation and preserve durable issue checkpoints", async () => {
  const fs = await import("node:fs/promises");
  for (const [name,fn] of Object.entries({createActiveTaskMemory,sanitizeCheckpoint,sanitizeCheckpointText,isCheckpointExpired}))
    assert.equal(legacyActiveMemory[name],fn);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"abr28-memory-"));
  try {
    const original=createActiveTaskMemory(dir);
    const saved=await original.update("REVREBEL/linear-agents","ABR-28",{
      lastJobKey:"delivery123",lastSessionId:"session-xyz",
      nextAction:"Inspect CI",notes:"token=secret-test-value"
    });
    assert.equal(saved.revision,1);
    assert.equal(saved.lastSessionId,"session-xyz");
    const older=legacyActiveMemory.createActiveTaskMemory(dir);
    const reopened=await older.read("REVREBEL/linear-agents","ABR-28");
    assert.deepEqual(reopened,saved);
    assert.equal(reopened.notes,"token=[REDACTED]");
    const next=await older.update("REVREBEL/linear-agents","ABR-28",{
      expectedRevision:1,lastVerifiedResult:"Tests passed"
    });
    assert.equal(next.revision,2);
    assert.equal((await original.read("REVREBEL/linear-agents","ABR-28")).lastVerifiedResult,"Tests passed");
    const entries=await fs.readdir(path.join(dir,"active-task-memory"));
    assert.equal(entries.filter(x=>x.endsWith(".json")).length,1);
    assert.ok(!entries.some(x=>x.endsWith(".lock")));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("P4 memU import identity and fail-open behavior remain unchanged", async () => {
  assert.equal(legacyMemuMemory.compactRecall,compactRecall);
  assert.equal(legacyMemuMemory.retrieveMemuMemory,retrieveMemuMemory);
  assert.equal(await retrieveMemuMemory("query",{enabled:false}),"");
  assert.equal(compactRecall({hits:[{description:"Relevant",text:"prior decision"}]}),"Relevant: prior decision");
});
test("P4 bridge uses canonical memory modules but keeps storage roots unchanged", async () => {
  const fs=await import("node:fs/promises");
  const source=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(source,/from "\.\.\/memory\/active-task-memory\.mjs"/);
  assert.match(source,/from "\.\.\/memory\/memu-memory\.mjs"/);
  assert.match(source,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(source,/createActiveTaskMemory\(JOBS_DIR\)/);
});

test("P4 GitHub PR task memory shares implementation and persists review metadata across old/new imports", async () => {
  const fs = await import("node:fs/promises");
  assert.equal(createGithubTaskMemory, legacyGithubTaskMemory);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abr28-github-task-"));
  const event = { repository: "REVREBEL/linear-agents", number: 123 };
  try {
    const canonical = createGithubTaskMemory(root);
    assert.equal(await canonical.read(event), null);
    const saved = await canonical.update(event, {
      lastReviewChange: "review:sha123", lastHeadSha: "a".repeat(40),
      lastDecision: "review_requested", status: "active"
    });
    assert.equal(saved.version,1);
    const old = legacyGithubTaskMemory(root);
    assert.deepEqual(await old.read(event), saved);
    const revised = await old.update(event, { lastDecision: "completed", status: "reviewed" });
    assert.equal(revised.lastReviewChange,"review:sha123");
    assert.equal(revised.lastHeadSha,"a".repeat(40));
    assert.deepEqual(await canonical.read(event), revised);
    const fileDir = path.join(root, "github-events", "task-memory");
    const entries = await fs.readdir(fileDir);
    assert.equal(entries.length,1);
    assert.match(entries[0],/^[a-f0-9]{64}\.json$/);
    assert.equal((await fs.stat(path.join(fileDir,entries[0]))).isFile(),true);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test("P4 GitHub task memory remains anchored to original bridge journal root", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url), "utf8");
  assert.match(source,/from "\.\.\/memory\/github-task-memory\.mjs"/);
  assert.match(source,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(source,/createGithubTaskMemory\(JOBS_DIR\)/);
});

test("P4 GitHub event classification retains legacy function identity and explicit self-origin policy", () => {
  for (const [name, fn] of Object.entries(githubIntegration))
    assert.equal(legacyGithubIntegration[name], fn, "Legacy GitHub event export must be same function: " + name);
  const input = {
    event:"pull_request", delivery:"delivery-abr28-001",
    payload:{
      action:"ready_for_review", repository:{full_name:"REVREBEL/linear-agents"},
      sender:{id:5321,login:"outside-reviewer"},
      pull_request:{number:124,html_url:"https://github.com/REVREBEL/linear-agents/pull/124",
        head:{sha:"a".repeat(40)},draft:false}
    }
  };
  const event=githubIntegration.sanitizeGithubEvent(input);
  assert.deepEqual(legacyGithubIntegration.classifyGithubReviewEvent(event,{}),
    githubIntegration.classifyGithubReviewEvent(event,{}));
  assert.equal(githubIntegration.classifyGithubReviewEvent(event,{}).actionable,true);
  assert.equal(githubIntegration.classifyGithubReviewEvent(event,{ids:["5321"]}).reason,"self-authored-event");
  assert.equal(githubIntegration.classifyGithubReviewEvent(event,{logins:["outside-reviewer"]}).reason,"self-authored-event");
  assert.equal(githubIntegration.classifyGithubReviewEvent(event,{ids:[],logins:[]}).actionable,true);
  assert.equal(githubIntegration.githubReviewChangeKey(event),legacyGithubIntegration.githubReviewChangeKey(event));
});
test("P4 GitHub event journal preserves original path and avoids storing comment bodies", async () => {
  const fs=await import("node:fs/promises");
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr28-github-events-"));
  try {
    const event={event:"issue_comment",delivery:"delivery-abr28-002",repository:"REVREBEL/linear-agents",
      number:124,commentBody:"Sensitive review body",commentId:8811,action:"created"};
    const result=await legacyGithubIntegration.recordGithubEvent(root,event,"chatgpt");
    assert.equal(result.journal,path.join(root,"github-events","events.jsonl"));
    const records=(await fs.readFile(result.journal,"utf8")).trim().split("\n");
    assert.equal(records.length,1);
    assert.equal(JSON.parse(records[0]).commentBody,undefined);
    assert.equal(JSON.parse(records[0]).source,"chatgpt");
    await assert.rejects(githubIntegration.recordGithubEvent(root,event,"invalid"),/Invalid GitHub source/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test("P4 bridge and review inbox reference canonical GitHub event adapter", async () => {
  const fs=await import("node:fs/promises");
  for(const file of ["../linear-agent-bridge/agent-bridge.mjs","../bridge/review-inbox.mjs"]){
    const content=await fs.readFile(new URL(file,import.meta.url),"utf8");
    assert.match(content,/from "\.\.\/integrations\/github-events\.mjs"/);
  }
  const bridge=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(bridge,/recordGithubEvent\(JOBS_DIR, event, source\)/);
});

test("P4 review inbox canonical and legacy paths preserve persisted queue and claim semantics", async () => {
  const fs = await import("node:fs/promises");
  assert.equal(createReviewInbox, legacyCreateReviewInbox);
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"abr28-review-inbox-"));
  const event = githubIntegration.sanitizeGithubEvent({
    event:"pull_request", delivery:"abr28-review-queue-001",
    payload: { action:"ready_for_review", repository:{full_name:"REVREBEL/linear-agents"},
      pull_request:{number:125,html_url:"https://github.com/REVREBEL/linear-agents/pull/125",head:{sha:"a".repeat(40)},draft:false} }
  });
  const destination={ok:true,projectIds:["project-review"],conversationUrl:"https://chatgpt.com/g/g-p-test/c/review"};
  try {
    const fresh = createReviewInbox(root);
    const created = await fresh.enqueue(event,{source:"chatgpt",destination});
    assert.equal(created.created,true);
    assert.equal(created.record.role,"chatgpt-user-review");
    assert.equal((await legacyCreateReviewInbox(root).enqueue(event,{source:"chatgpt",destination})).created,false);
    assert.equal((await legacyCreateReviewInbox(root).list()).length,1);
    assert.equal((await legacyCreateReviewInbox(root).claim(created.record.reviewId,"chatgpt-user")).state,"claimed");
    await assert.rejects(fresh.claim(created.record.reviewId,"other"),/already claimed/);
    await assert.rejects(fresh.finish(created.record.reviewId,{status:"reviewed",summary:"verified"}),/Published GitHub review evidence required/);
    const finished=await fresh.finish(created.record.reviewId,{status:"blocked",summary:"CI check blocked"});
    assert.equal(finished.state,"blocked");
    assert.equal((await legacyCreateReviewInbox(root).list({state:"blocked"})).length,1);
    const target=path.join(root,"github-events","review-inbox",created.record.reviewId+".json");
    assert.equal((await fs.stat(target)).isFile(),true);
    assert.equal((await fs.stat(target)).mode & 0o077,0);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test("P4 review inbox handoff attempt is not replayed after a pending restart", async () => {
  const fs = await import("node:fs/promises");
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"abr28-review-handoff-"));
  const event = githubIntegration.sanitizeGithubEvent({
    event:"pull_request",delivery:"abr28-review-queue-002",
    payload:{action:"opened",repository:{full_name:"REVREBEL/linear-agents"},
      pull_request:{number:126,html_url:"https://github.com/REVREBEL/linear-agents/pull/126",head:{sha:"b".repeat(40)},draft:false}}
  });
  const destination={ok:true,projectIds:["project-review"],conversationUrl:"https://chatgpt.com/g/g-p-test/c/review"};
  try {
    const inbox=createReviewInbox(root);
    const {record}=await inbox.enqueue(event,{source:"chatgpt",destination});
    const attempt=await inbox.beginMessageHandoff(record.reviewId);
    assert.equal(attempt.started,true);
    const afterRestart=await legacyCreateReviewInbox(root).beginMessageHandoff(record.reviewId);
    assert.equal(afterRestart.started,false);
    assert.equal(afterRestart.record.messageHandoff.state,"attempting");
    const finalized=await inbox.finishMessageHandoff(record.reviewId,{attempted:false,error:"unknown send outcome"});
    assert.equal(finalized.messageHandoff.state,"uncertain");
    assert.equal((await legacyCreateReviewInbox(root).beginMessageHandoff(record.reviewId)).started,false);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test("P4 bridge imports canonical review inbox while retaining original journal root", async () => {
  const fs=await import("node:fs/promises");
  const source=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(source,/from "\.\.\/bridge\/review-inbox\.mjs"/);
  assert.match(source,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(source,/createReviewInbox\(JOBS_DIR\)/);
});
