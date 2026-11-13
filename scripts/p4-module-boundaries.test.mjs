import { prepareLocalAgentTask } from "../jobs/local-task-preparation.mjs";
import { preflightLinearJob } from "../jobs/job-preflight.mjs";
import { identifyLinearJobDelivery, linearJobDuplicateResponse } from "../jobs/job-admission.mjs";
import { createIssueCompletionRoute } from "../bridge/issue-completion-route.mjs";
import { createTraeCallbackRoutes } from "../bridge/trae-callback-routes.mjs";
import { createGithubWebhookRoutes } from "../bridge/github-webhook-routes.mjs";
import { createReviewRoutes } from "../bridge/review-routes.mjs";
import { createDiagnosticRoutes } from "../bridge/diagnostic-routes.mjs";
import { normalizeHost, matchesHost, readBody, sendJson } from "../bridge/http-helpers.mjs";
import { PassThrough } from "node:stream";
import * as remoteActivity from "../routing/remote-trae-activity.mjs";
import * as legacyRemoteActivity from "../linear-agent-bridge/remote-trae-activity.mjs";
import * as sshDispatch from "../routing/ssh-dispatch.mjs";
import * as legacySshDispatch from "../linear-agent-bridge/ssh-dispatch.mjs";
import * as linearCredentials from "../integrations/linear-credentials.mjs";
import * as legacyLinearCredentials from "../linear-agent-bridge/linear-credentials.mjs";
import * as reviewDelivery from "../bridge/review-delivery.mjs";
import * as legacyReviewDelivery from "../linear-agent-bridge/review-delivery.mjs";
import * as messageHandoff from "../bridge/review-message-handoff.mjs";
import * as legacyMessageHandoff from "../linear-agent-bridge/review-message-handoff.mjs";
import * as linearReviewNotifier from "../integrations/review-linear-notifier.mjs";
import * as legacyLinearReviewNotifier from "../linear-agent-bridge/review-linear-notifier.mjs";
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
  const handler=await fs.readFile(new URL("../bridge/github-webhook-routes.mjs",import.meta.url),"utf8");
  assert.match(bridge,/createGithubWebhookRoutes\(/);
  assert.match(handler,/recordGithubEvent\(JOBS_DIR, event, source\)/);
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

test("P4 review delivery and notification APIs preserve legacy function identity", () => {
  for (const [canonical, legacy] of [
    [reviewDelivery,legacyReviewDelivery],
    [messageHandoff,legacyMessageHandoff],
    [linearReviewNotifier,legacyLinearReviewNotifier],
  ]) {
    assert.deepEqual(Object.keys(legacy).sort(),Object.keys(canonical).sort());
    for (const [name,fn] of Object.entries(canonical))
      assert.equal(legacy[name],fn,"review export identity: "+name);
  }
});
test("P4 review delivery retains exact-head published-review evidence requirement", async () => {
  const sha="a".repeat(40), record={repository:"REVREBEL/linear-agents",number:126,headSha:sha};
  const fetchImpl=async url=>({ok:true,json:async()=>url.endsWith("/reviews/321")
    ? {id:321,state:"COMMENTED",submitted_at:"2026-11-12T12:00:00Z",user:{login:"revrebel-chatgpt"},
      commit_id:sha,html_url:"https://github.com/REVREBEL/linear-agents/pull/126#pullrequestreview-321"}
    : {number:126,base:{repo:{full_name:record.repository}},head:{sha}}});
  const verify=evidence=>reviewDelivery.verifyPublishedGithubReview(record,evidence,{token:"test",reviewerLogin:"revrebel-chatgpt",fetchImpl});
  const result=await verify({githubReviewId:321});
  assert.equal(result.githubReviewedCommit,sha);
  assert.ok(result.verifiedAt);
  await assert.rejects(verify({githubReviewId:0}),/Valid GitHub review ID/);
  await assert.rejects(reviewDelivery.verifyPublishedGithubReview({...record,headSha:"b".repeat(40)},{githubReviewId:321},
    {token:"test",reviewerLogin:"revrebel-chatgpt",fetchImpl}),/stale/);
});
test("P4 Linear reviewer notifications keep stable PR UUID and human reviewer role", () => {
  const record={repository:"REVREBEL/linear-agents",number:126,
    prUrl:"https://github.com/REVREBEL/linear-agents/pull/126",reviewId:"a".repeat(64),
    reason:"new-commit",headSha:"b".repeat(40)};
  const opts={teamId:"00000000-0000-4000-8000-000000000001",userId:"00000000-0000-4000-8000-000000000002"};
  const input=linearReviewNotifier.reviewIssueInput(record,opts);
  assert.equal(input.id,legacyLinearReviewNotifier.reviewLinearIssueId(record.repository,126));
  assert.equal(input.assigneeId,opts.userId);
  assert.match(input.description,/NOT an assignment to the ChatGPT CLI coding agent/);
  assert.notEqual(input.id,linearReviewNotifier.reviewLinearIssueId(record.repository,127));
});
test("P4 review SSH handoff preserves fixed trusted runner policy", () => {
  const env={MAC_SSH_HOST:"mac",MAC_NODE_BIN:"node",OSX_PROJECTS_ROOT:"/Users/rebel/repos"};
  const args=messageHandoff.reviewSshArgs(env);
  assert.equal(args.at(-2),"mac");
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.throws(()=>messageHandoff.reviewSshArgs({...env,MAC_SSH_HOST:"-evil"}),/trusted SSH/);
});
test("P4 canonical review modules are used by bridge without relocating review data", async () => {
  const fs=await import("node:fs/promises");
  const src=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  for(const location of ["../bridge/review-delivery.mjs","../bridge/review-message-handoff.mjs",
    "../integrations/review-linear-notifier.mjs"])
    assert.ok(src.includes('from "'+location+'"'));
  assert.match(src,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(src,/createReviewInbox\(JOBS_DIR\)/);
});

test("P4 Linear credential adapter preserves legacy exports and independent agent variables", () => {
  for (const [name, fn] of Object.entries(linearCredentials))
    assert.equal(legacyLinearCredentials[name], fn, "credential export identity: " + name);
  assert.equal(linearCredentials.LINEAR_AGENT_VARS.chatgpt, "CHATGPT_LINEAR_API_KEY");
  assert.equal(linearCredentials.LINEAR_AGENT_VARS["chatgpt-cli"], "CHATGPT_CLI_LINEAR_API_KEY");
  assert.notEqual(linearCredentials.LINEAR_AGENT_VARS.chatgpt, linearCredentials.LINEAR_AGENT_VARS["chatgpt-cli"]);
  assert.ok(Object.isFrozen(linearCredentials.LINEAR_AGENT_VARS));
});
test("P4 canonical Linear credential handoff retains worker pinning and no-persistence mode", async () => {
  let requests=0;
  const opts={
    agent:"antigravity",repositoryRoot:"/not-used",organizationId:"org-test",
    completionUrl:"https://linear-antigravity.example.test/complete",sharedSecret:"test-secret",
    persist:false,
    fetchImpl:async (url, init)=>{
      requests++;
      assert.equal(url.href,"https://linear-antigravity.example.test/bridge/access-token");
      assert.equal(init.headers.authorization,"Bearer test-secret");
      assert.equal(JSON.parse(init.body).organizationId,"org-test");
      return {ok:true,json:async()=>({ok:true,accessToken:"short-lived-test-token",expiresAt:123})};
    },
  };
  const credential=await legacyLinearCredentials.syncLinearCredential(opts);
  assert.deepEqual(credential,{
    variable:"ANTIGRAVITY_LINEAR_API_KEY",accessToken:"short-lived-test-token",expiresAt:123
  });
  assert.equal(requests,1);
  await assert.rejects(linearCredentials.syncLinearCredential({...opts,completionUrl:"http://linear-antigravity.example.test/complete"}),/Unexpected worker completion URL/);
  await assert.rejects(linearCredentials.syncLinearCredential({...opts,completionUrl:"https://other.example.test/complete"}),/Unexpected worker completion URL/);
  assert.equal(requests,1);
});
test("P4 bridge imports canonical credentials without moving its startup entrypoint", async () => {
  const fs=await import("node:fs/promises");
  const src=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(src,/from "\.\.\/integrations\/linear-credentials\.mjs"/);
  assert.match(src,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
});

test("P4 remote activity and SSH dispatch maintain legacy export function identity", () => {
  for (const [canonical,legacy] of [[remoteActivity,legacyRemoteActivity],[sshDispatch,legacySshDispatch]]) {
    assert.deepEqual(Object.keys(canonical).sort(),Object.keys(legacy).sort());
    for (const [name,fn] of Object.entries(canonical)) assert.equal(legacy[name],fn,name+" compatibility");
  }
});
test("P4 remote Trae capability requires exact job, session, workspace, host, state and token", () => {
  const token="a".repeat(64);
  const job={agent:"trae",executionHost:"macos",key:"delivery-777",agentSessionId:"linear-session-7",
    workspace:"REVREBEL/project",remoteActivityTokenHash:remoteActivity.hashRemoteToken(token),
    state:"running",remoteCompletionUrl:"https://linear-trae.example.com/complete"};
  const activity={token,jobKey:job.key,agentSessionId:job.agentSessionId,workspace:job.workspace};
  assert.equal(remoteActivity.validateRemoteTraeActivity(activity,job),true);
  for(const patch of [{jobKey:"wrong"},{agentSessionId:"wrong"},{workspace:"wrong"},{token:"b".repeat(64)}])
    assert.equal(remoteActivity.validateRemoteTraeActivity({...activity,...patch},job),false);
  for(const patch of [{agent:"chatgpt-cli"},{executionHost:"bridge-server"},{state:"completed"},{remoteCompletionUrl:"http://untrusted/complete"}])
    assert.equal(remoteActivity.validateRemoteTraeActivity(activity,{...job,...patch}),false);
  assert.equal(remoteActivity.validateActivityEndpoint("https://linear-trae.example.com/trae-activity","linear-trae.example.com"),
    "https://linear-trae.example.com/trae-activity");
  assert.throws(()=>remoteActivity.validateActivityEndpoint("https://evil.example.com/trae-activity","linear-trae.example.com"),/expected HTTPS/);
  assert.throws(()=>remoteActivity.validateTraeCompletionUrl("http://linear-trae.example.com/complete","linear-trae.example.com"),/Unexpected/);
});
test("P4 SSH dispatch preserves trusted alias, fixed runner and no issue text interpolation", () => {
  const env={MAC_SSH_HOST:"mac-agent",MAC_NODE_BIN:"node",OSX_PROJECTS_ROOT:"/Users/rebel/repositories"};
  const args=sshDispatch.buildSshArgs(env);
  assert.equal(args.at(-2),"mac-agent");
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.match(args.at(-1),/agents\/trae\/scripts\/launch\.mjs/);
  assert.ok(!args.join(" ").includes("issue body"));
  assert.throws(()=>sshDispatch.buildSshArgs({...env,MAC_SSH_HOST:"-oProxyCommand=evil"}),/trusted SSH/);
  assert.throws(()=>sshDispatch.buildSshArgs({...env,MAC_NODE_BIN:"node;evil"}),/MAC_NODE_BIN/);
});
test("P4 bridge imports canonical remote activity and SSH dispatch without moving job roots", async () => {
  const fs=await import("node:fs/promises");
  const source=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(source,/from "\.\.\/routing\/remote-trae-activity\.mjs"/);
  assert.match(source,/from "\.\.\/routing\/ssh-dispatch\.mjs"/);
  assert.match(source,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
});

test("P4 HTTP host primitives retain exact legacy normalization and subdomain matching", () => {
  assert.equal(normalizeHost("Linear-Trae.Example.COM:8788"),"linear-trae.example.com");
  assert.equal(normalizeHost(null),"");
  assert.equal(matchesHost("linear-trae.example.com","linear-trae.example.com"),true);
  assert.equal(matchesHost("api.linear-trae.example.com","linear-trae.example.com"),true);
  assert.equal(matchesHost("evil-linear-trae.example.com","linear-trae.example.com"),false);
  assert.equal(matchesHost("linear-trae.example.com.evil.org","linear-trae.example.com"),false);
});
test("P4 HTTP request reader preserves UTF-8 body and 1 MB size ceiling", async () => {
  const input=new PassThrough();
  const body=readBody(input);
  input.end(Buffer.from('{"msg":"héllo"}',"utf8"));
  assert.equal(await body,'{"msg":"héllo"}');
  const oversized=new PassThrough();
  const rejected=readBody(oversized);
  oversized.write(Buffer.alloc(1_000_001,0x41));
  await assert.rejects(rejected,/Body too large/);
});
test("P4 HTTP JSON response retains no-store and formatted JSON body", () => {
  const calls=[];
  const response={
    writeHead:(status,headers)=>calls.push({status,headers}),
    end:body=>calls.push({body}),
  };
  sendJson(response,202,{ok:true,reviewQueued:false});
  assert.deepEqual(calls[0],{status:202,headers:{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
  }});
  assert.equal(calls[1].body,JSON.stringify({ok:true,reviewQueued:false},null,2));
});
test("P4 live bridge invokes canonical helpers and retains original HTTP route table", async () => {
  const fs=await import("node:fs/promises");
  const source=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(source,/from "\.\.\/bridge\/http-helpers\.mjs"/);
  assert.match(source,/const server = http\.createServer\(async \(request, response\) => \{/);
  assert.match(source,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.equal(source.includes("function readBody(request) {"),false);
  assert.equal(source.includes("function sendJson(response, status, body) {"),false);
});

test("P4 diagnostics preserve health shape and exact probe authentication", () => {
  const makeResponse=()=>({status:null,headers:null,body:null,
    writeHead(status,headers){this.status=status;this.headers=headers;},
    end(body){this.body=JSON.parse(body);}
  });
  const health={port:8788,jobsDir:"/same/linear-jobs",hasBridgeSharedSecret:true,
    antigravityHost:"ag.example.test",chatgptHost:"chatgpt.example.test",mockHost:"mock.example.test"};
  const handle=createDiagnosticRoutes({health,sharedSecret:"test-shared-secret",agentForHost:host=>
    host==="ag.example.test"?"antigravity":"unknown"});
  const call=(method,pathname,headers={})=>{
    const request={method,headers},response=makeResponse();
    const handled=handle(request,response,{host:"ag.example.test",url:new URL("http://ag.example.test"+pathname)});
    return {handled,response};
  };
  const healthResult=call("GET","/health");
  assert.equal(healthResult.handled,true);
  assert.equal(healthResult.response.status,200);
  assert.deepEqual(healthResult.response.body,{ok:true,service:"local-linear-agent-router",host:"ag.example.test",...health});
  assert.equal(healthResult.response.headers["cache-control"],"no-store");
  const denied=call("POST","/diagnostics/probe",{authorization:"Bearer incorrect","x-bridge-probe-id":"a".repeat(36)});
  assert.equal(denied.response.status,401);
  assert.deepEqual(denied.response.body,{ok:false,error:"Unauthorized"});
  const malformed=call("POST","/diagnostics/probe",{authorization:"Bearer test-shared-secret","x-bridge-probe-id":"too-short"});
  assert.equal(malformed.response.status,400);
  const probeId="12345678-1234-1234-1234-123456789abc";
  const allowed=call("POST","/diagnostics/probe",{authorization:"Bearer test-shared-secret","x-bridge-probe-id":probeId});
  assert.equal(allowed.response.status,200);
  assert.deepEqual(allowed.response.body,{ok:true,probeId,service:"local-linear-agent-router",agent:"antigravity"});
  const other=call("POST","/jobs");
  assert.equal(other.handled,false);
  assert.equal(other.response.status,null);
  assert.equal(call("GET","/diagnostics/probe").handled,false);
  assert.equal(call("POST","/health").handled,false);
  const withoutSecret=createDiagnosticRoutes({health,sharedSecret:"",agentForHost:()=> "unknown"});
  const response=makeResponse();
  assert.equal(withoutSecret({method:"POST",headers:{authorization:"Bearer "} },response,
    {host:"ag.example.test",url:new URL("http://ag.example.test/diagnostics/probe")}),true);
  assert.equal(response.status,401);
});
test("P4 diagnostic handlers are delegated but HTTP listener and job routes remain anchored", async () => {
  const fs=await import("node:fs/promises");
  const src=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(src,/from "\.\.\/bridge\/diagnostic-routes\.mjs"/);
  assert.match(src,/if \(handleDiagnosticRoute\(request, response, \{ host, url \}\)\) return;/);
  assert.match(src,/const server = http\.createServer\(async \(request, response\) => \{/);
  assert.match(src,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(src,/request\.method !== "POST" \|\| url\.pathname !== "\/jobs"/);
});

test("P4 review HTTP routes retain separate token, claim, completion and published evidence policy", async () => {
  const requests=[];
  const reviewId="a".repeat(64),headSha="b".repeat(40);
  const record={reviewId,repository:"REVREBEL/linear-agents",number:131,headSha,state:"claimed"};
  const reviewInbox={
    list:async query=>{requests.push(["list",query]);return [record];},
    claim:async (id,reviewer)=>{requests.push(["claim",id,reviewer]);return record;},
    get:async id=>{requests.push(["get",id]);return record;},
    finish:async (id,body)=>{requests.push(["finish",id,body]);return {...record,state:body.status,delivery:body.delivery};},
  };
  const verifyPublishedGithubReview=async (existing,body,options)=>{
    requests.push(["verify",existing,body,options]);
    return {githubReviewId:101,githubReviewedCommit:headSha,verifiedAt:"2026-11-12T00:00:00Z"};
  };
  const handle=createReviewRoutes({reviewInbox,verifyPublishedGithubReview,
    safeTokenEqual:(actual,expected)=>actual===expected,
    env:{CHATGPT_REVIEW_MODE:"inbox",CHATGPT_REVIEW_INBOX_TOKEN:"s".repeat(40),
      CHATGPT_REVIEW_GITHUB_TOKEN:"test-token",CHATGPT_REVIEW_GITHUB_LOGIN:"reviewer"}});
  const invoke=async (method,pathname,payload,authorization="Bearer "+"s".repeat(40))=>{
    const stream=new PassThrough();
    stream.method=method;stream.headers={authorization};
    const response={status:null,body:null,writeHead(status){this.status=status;},end(data){this.body=JSON.parse(data);}};
    const run=handle(stream,response,{url:new URL("http://localhost"+pathname)});
    if(payload!==undefined)stream.end(JSON.stringify(payload));else stream.end();
    const handled=await run;
    return {handled,...response};
  };
  const other=await invoke("POST","/jobs");
  assert.equal(other.handled,false);
  const denied=await invoke("GET","/reviews/pending",undefined,"Bearer wrong");
  assert.equal(denied.status,401);
  assert.equal(requests.length,0);
  const pending=await invoke("GET","/reviews/pending");
  assert.equal(pending.status,200);
  assert.deepEqual(pending.body.reviews,[record]);
  assert.deepEqual(requests[0],["list",{limit:20}]);
  const claimed=await invoke("POST","/reviews/claim",{reviewId,reviewer:"chatgpt-user"});
  assert.equal(claimed.status,200);
  assert.deepEqual(requests[1],["claim",reviewId,"chatgpt-user"]);
  const reviewed=await invoke("POST","/reviews/complete",{reviewId,status:"reviewed",summary:"Published"});
  assert.equal(reviewed.status,200);
  assert.equal(requests[3][0],"verify");
  assert.equal(requests[3][3].reviewerLogin,"reviewer");
  assert.equal(requests[4][0],"finish");
  assert.equal(requests[4][2].delivery.githubReviewedCommit,headSha);
  const unsupported=await invoke("DELETE","/reviews/pending");
  assert.equal(unsupported.status,405);
  const disabled=createReviewRoutes({reviewInbox,verifyPublishedGithubReview,
    safeTokenEqual:()=>true,env:{CHATGPT_REVIEW_MODE:"off"}});
  const response={status:null,writeHead(code){this.status=code;},end(){}};
  assert.equal(await disabled({method:"GET",headers:{}},response,{url:new URL("http://localhost/reviews/pending")}),true);
  assert.equal(response.status,404);
});
test("P4 review routes keep evidence-verification failure and unclaimed states as conflicts", async () => {
  const makeResponse=()=>({status:null,body:null,writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}});
  const reviewId="a".repeat(64);
  const handler=createReviewRoutes({
    reviewInbox:{get:async()=>({state:"pending"}),finish:async()=>{throw Error("must not finish");}},
    verifyPublishedGithubReview:async()=>{throw Error("must not verify");},
    safeTokenEqual:(a,b)=>a===b,
    env:{CHATGPT_REVIEW_MODE:"inbox",CHATGPT_REVIEW_INBOX_TOKEN:"s".repeat(40)}
  });
  const request=new PassThrough();request.method="POST";request.headers={authorization:"Bearer "+"s".repeat(40)};
  const response=makeResponse();
  const called=handler(request,response,{url:new URL("http://localhost/reviews/complete")});
  request.end(JSON.stringify({reviewId,status:"reviewed",summary:"Test"}));
  assert.equal(await called,true);
  assert.equal(response.status,409);
  assert.equal(response.body.error,"Review must be claimed first");
});
test("P4 review route extraction keeps original job dispatcher and path anchors", async () => {
  const fs=await import("node:fs/promises");
  const source=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(source,/from "\.\.\/bridge\/review-routes\.mjs"/);
  assert.match(source,/await handleReviewRoute\(request, response, \{ url \}\)/);
  assert.match(source,/const server = http\.createServer\(async \(request, response\) => \{/);
  assert.match(source,/createReviewInbox\(JOBS_DIR\)/);
  assert.match(source,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
});

test("P4 GitHub ingress preserves authorization, agent validation and side-effect-free preflights", async () => {
  const fs = await import("node:fs/promises");
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"abr28-webhook-preflight-"));
  const event = {event:"pull_request",delivery:"abr28-webhook-001",payload:{
    action:"ready_for_review",repository:{full_name:"REVREBEL/linear-agents"},
    pull_request:{number:132,html_url:"https://github.com/REVREBEL/linear-agents/pull/132",
      head:{sha:"a".repeat(40)},draft:false},
  }};
  const activity=[];
  const deps={
    sharedSecret:"bridge-secret",jobsDir:root,linearApiKey:"",selfIdentity:{ids:[],logins:[]},
    githubTaskMemory:{update:async()=>activity.push("memory")},
    claimGithubReviewDispatch:async()=>{activity.push("claim");return null;},
    launchGithubShortcutHandoff:()=>activity.push("launch"),
    platform:"linux",env:{CHATGPT_REVIEW_MODE:"inbox",CHATGPT_REVIEW_INBOX_TOKEN:"i".repeat(40)},
    logger:{log:()=>{}},
  };
  const run=async (patch={},payload=event,method="POST",pathname="/github/events")=>{
    const request=new PassThrough();
    request.method=method;
    request.headers={authorization:"Bearer bridge-secret","x-github-agent":"chatgpt",...patch};
    const response={status:null,body:null,writeHead(status){this.status=status;},
      end(body){this.body=JSON.parse(body);}};
    const promise=createGithubWebhookRoutes(deps)(request,response,{url:new URL("http://localhost"+pathname)});
    request.end(JSON.stringify(payload));
    const handled=await promise;
    return {handled,...response};
  };
  try{
    assert.equal((await run({},event,"GET")).handled,false);
    assert.equal((await run({},event,"POST","/jobs")).handled,false);
    assert.equal((await run({authorization:"Bearer wrong"})).status,401);
    assert.equal((await run({"x-github-agent":"other"})).status,400);
    assert.equal((await run({},{"invalid":"payload"})).status,400);
    assert.deepEqual(activity,[]);
    assert.equal((await fs.readdir(root)).length,0);
    const requiresInbox=createGithubWebhookRoutes({...deps,env:{CHATGPT_REVIEW_MODE:"inbox",CHATGPT_REVIEW_INBOX_TOKEN:"short"}});
    const request=new PassThrough();request.method="POST";request.headers={authorization:"Bearer bridge-secret","x-github-agent":"chatgpt"};
    const response={status:null,writeHead(code){this.status=code;},end(){}};
    const pending=requiresInbox(request,response,{url:new URL("http://localhost/github/events")});
    request.end(JSON.stringify(event));
    assert.equal(await pending,true);
    assert.equal(response.status,503);
    assert.deepEqual(activity,[]);
  } finally { await fs.rm(root,{recursive:true,force:true});}
});
test("P4 GitHub ingress preserves delivery dedupe, semantic recovery and journal state", async () => {
  const fs = await import("node:fs/promises");
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"abr28-webhook-dedupe-"));
  const event={event:"pull_request",delivery:"abr28-webhook-002",payload:{
    action:"ready_for_review",repository:{full_name:"REVREBEL/linear-agents"},
    pull_request:{number:132,html_url:"https://github.com/REVREBEL/linear-agents/pull/132",
      head:{sha:"b".repeat(40)},draft:false},
  }};
  const calls={claims:0,launches:0,patches:[]};
  const handle=createGithubWebhookRoutes({
    sharedSecret:"bridge-secret",jobsDir:root,linearApiKey:"",
    selfIdentity:{ids:[],logins:[]},
    githubTaskMemory:{update:async(_event,patch)=>calls.patches.push(patch)},
    claimGithubReviewDispatch:async()=>{
      calls.claims++;
      return calls.claims===1?{reviewQueued:true,reviewId:"r".repeat(64),handoffId:"r".repeat(64),reviewNotified:false}: {duplicate:true};
    },
    launchGithubShortcutHandoff:()=>{calls.launches++;},
    platform:"linux",env:{CHATGPT_REVIEW_MODE:"inbox",CHATGPT_REVIEW_INBOX_TOKEN:"i".repeat(40)},
    logger:{log:()=>{}},
  });
  const requestOnce=async()=>{
    const request=new PassThrough();request.method="POST";
    request.headers={authorization:"Bearer bridge-secret","x-github-agent":"chatgpt"};
    const response={status:null,body:null,writeHead(code){this.status=code;},end(body){this.body=JSON.parse(body);}};
    const promise=handle(request,response,{url:new URL("http://localhost/github/events")});
    request.end(JSON.stringify(event));
    assert.equal(await promise,true);
    return response;
  };
  try {
    const accepted=await requestOnce();
    assert.equal(accepted.status,202);
    assert.equal(accepted.body.accepted,true);
    assert.equal(accepted.body.reviewQueued,true);
    assert.equal(calls.claims,1);
    assert.equal(calls.launches,1);
    assert.equal(calls.patches.length,1);
    assert.equal(calls.patches[0].lastReviewChange!==undefined,true);
    const journal=await fs.readFile(path.join(root,"github-events","events.jsonl"),"utf8");
    assert.equal(journal.trim().split("\n").length,1);
    const duplicate=await requestOnce();
    assert.equal(duplicate.status,202);
    assert.equal(duplicate.body.duplicate,true);
    assert.equal(calls.claims,2);
    assert.equal(calls.launches,1);
    assert.equal(calls.patches.length,1);
    assert.equal((await fs.readFile(path.join(root,"github-events","events.jsonl"),"utf8")).trim().split("\n").length,1);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test("P4 GitHub webhook failure releases delivery claim for retry", async () => {
  const fs=await import("node:fs/promises");
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr28-webhook-failure-"));
  const event={event:"pull_request",delivery:"abr28-webhook-003",payload:{
    action:"ready_for_review",repository:{full_name:"REVREBEL/linear-agents"},
    pull_request:{number:132,html_url:"https://github.com/REVREBEL/linear-agents/pull/132",
      head:{sha:"c".repeat(40)},draft:false},
  }};
  const handler=createGithubWebhookRoutes({
    sharedSecret:"bridge-secret",jobsDir:root,linearApiKey:"",
    selfIdentity:{ids:[],logins:[]},
    githubTaskMemory:{update:async()=>{}},
    claimGithubReviewDispatch:async()=>{throw Error("transient dispatch failure");},
    launchGithubShortcutHandoff:()=>{},
    platform:"linux",env:{CHATGPT_REVIEW_MODE:"inbox",CHATGPT_REVIEW_INBOX_TOKEN:"i".repeat(40)},
    logger:{log:()=>{}},
  });
  try {
    const request=new PassThrough();request.method="POST";
    request.headers={authorization:"Bearer bridge-secret","x-github-agent":"chatgpt"};
    const response={status:null,body:null,writeHead(status){this.status=status;},end(data){this.body=JSON.parse(data);}};
    const promise=handler(request,response,{url:new URL("http://localhost/github/events")});
    request.end(JSON.stringify(event));
    assert.equal(await promise,true);
    assert.equal(response.status,503);
    assert.equal(response.body.error,"transient dispatch failure");
    await assert.rejects(fs.stat(path.join(root,"github-events","chatgpt-abr28-webhook-003.claim")),{code:"ENOENT"});
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test("P4 Trae callbacks preserve remote activity auth, throttling, and completion confirmation", async () => {
  const token="a".repeat(64);
  const job={key:"trae:delivery-17",agent:"trae",executionHost:"macos",state:"running",
    agentSessionId:"session-17",workspace:"/Users/test/workspace",
    remoteCompletionUrl:"https://linear-trae.example.com/complete",
    remoteActivityTokenHash:remoteActivity.hashRemoteToken(token)};
  const event={jobKey:job.key,agentSessionId:job.agentSessionId,workspace:job.workspace,token,body:"Milestone reached"};
  const updates=[],posts=[],throttles=new Map();
  const handler=createTraeCallbackRoutes({
    jobStore:{get:async()=>job,transition:async(...args)=>updates.push(args)},
    projectsRoot:"/Users/test",traeActivityState:throttles,
    readTraeActivityContext:async()=>null,safeTokenEqual:(a,b)=>a===b,
    sanitizeTraeActivityBody:value=>value,
    postTraeActivity:async(...args)=>{posts.push(args);return true;},
    now:()=>100000,
  });
  const call=async(pathname,payload,method="POST")=>{
    const request=new PassThrough();request.method=method;
    const response={status:null,body:null,writeHead(status){this.status=status;},end(data){this.body=JSON.parse(data);}};
    const running=handler(request,response,{url:new URL("http://localhost"+pathname)});
    request.end(JSON.stringify(payload));
    return {handled:await running,...response};
  };
  assert.equal((await call("/jobs",event)).handled,false);
  const first=await call("/trae-activity",event);
  assert.equal(first.status,202);
  assert.equal(first.body.throttled,undefined);
  assert.equal(posts.length,1);
  const second=await call("/trae-activity",event);
  assert.equal(second.status,202);
  assert.equal(second.body.throttled,true);
  assert.equal(posts.length,1);
  assert.equal((await call("/trae-activity",{...event,token:"b".repeat(64)})).status,401);
  assert.equal((await call("/trae-complete",{...event,status:"invalid"})).status,422);
  assert.equal(updates.length,0);
  const completion=await call("/trae-complete",{...event,status:"completed"});
  assert.equal(completion.status,202);
  assert.equal(completion.body.status,"completed");
  assert.equal(updates.length,1);
  assert.equal(updates[0][0],job.key);
  assert.equal(updates[0][1],"completed");
  assert.equal(updates[0][2].remoteCompletionStatus,"completed");
  assert.ok(updates[0][2].remoteCompletionConfirmedAt);
});
test("P4 Trae completion retries remain idempotent and do not downgrade terminal jobs", async () => {
  const token="b".repeat(64);
  const job={key:"trae:delivery-18",agent:"trae",executionHost:"macos",state:"completed",
    agentSessionId:"session-18",workspace:"/Users/test/workspace",
    remoteCompletionUrl:"https://linear-trae.example.com/complete",
    remoteActivityTokenHash:remoteActivity.hashRemoteToken(token)};
  let transitions=0,posts=0;
  const handler=createTraeCallbackRoutes({
    jobStore:{get:async()=>job,transition:async()=>{transitions++;}},
    projectsRoot:"/Users/test",traeActivityState:new Map(),
    readTraeActivityContext:async()=>null,safeTokenEqual:(a,b)=>a===b,
    sanitizeTraeActivityBody:v=>v,
    postTraeActivity:async()=>{posts++;return true;},
  });
  const request=new PassThrough();request.method="POST";
  const response={status:null,body:null,writeHead(v){this.status=v;},end(v){this.body=JSON.parse(v);}};
  const task=handler(request,response,{url:new URL("http://localhost/trae-complete")});
  request.end(JSON.stringify({jobKey:job.key,agentSessionId:job.agentSessionId,
    workspace:job.workspace,token,body:"Already done",status:"completed"}));
  assert.equal(await task,true);
  assert.equal(response.status,202);
  assert.equal(response.body.duplicate,true);
  assert.equal(transitions,0);
  assert.equal(posts,0);
});
test("P4 Trae callback route extraction retains bridge-owned job and activity state", async () => {
  const fs=await import("node:fs/promises");
  const src=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.match(src,/from "\.\.\/bridge\/trae-callback-routes\.mjs"/);
  assert.match(src,/await handleTraeCallbackRoute\(request, response, \{ url \}\)/);
  assert.match(src,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(src,/const traeActivityState = new Map\(\)/);
  assert.match(src,/createTraeCallbackRoutes\(\{/);
});

test("P4 issue completion route preserves auth, issue validation, and non-route fallthrough", async () => {
  const issueId="12345678-1234-1234-1234-123456789abc";
  let lookedUp=0,transitions=0,macCalls=0;
  const handle=createIssueCompletionRoute({
    sharedSecret:"bridge-test-secret",
    jobStore:{findByIssueId:async()=>{lookedUp++;return [];},transition:async()=>{transitions++;}},
    cleanupMacTrae:async()=>{macCalls++;},
    osxProjectsRoot:"/Users/test/projects",
  });
  const invoke=async (method,pathname,body,authorization="Bearer bridge-test-secret")=>{
    const request=new PassThrough();
    request.method=method;request.headers={authorization};
    const response={status:null,body:null,writeHead(status){this.status=status;},end(value){this.body=JSON.parse(value);}};
    const processing=handle(request,response,{url:new URL("http://localhost"+pathname)});
    request.end(JSON.stringify(body));
    return {handled:await processing,status:response.status,body:response.body};
  };
  assert.equal((await invoke("GET","/issue-completed",{issueId})).handled,false);
  assert.equal((await invoke("POST","/jobs",{issueId})).handled,false);
  assert.equal((await invoke("POST","/issue-completed",{issueId},"Bearer invalid")).status,401);
  assert.equal((await invoke("POST","/issue-completed",{issueId:"invalid"})).status,400);
  assert.equal(lookedUp,0);
  assert.equal(transitions,0);
  assert.equal(macCalls,0);
  const accepted=await invoke("POST","/issue-completed",{issueId});
  assert.equal(accepted.status,200);
  assert.deepEqual(accepted.body,{ok:true,issueId,cleaned:0});
  assert.equal(lookedUp,1);
});
test("P4 issue completion handles Mac cleanup, local inbox removal, and only allowed paths", async () => {
  const fs=await import("node:fs/promises");
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr28-issue-clean-"));
  const issueId="12345678-1234-1234-1234-123456789abc";
  const allowed=path.join(root,".linear-agent","projects","project-a","inbox","assignment.json");
  const forbidden=path.join(root,"outside","assignment.json");
  const transitions=[],mac=[];
  try {
    await fs.mkdir(path.dirname(allowed),{recursive:true});
    await fs.mkdir(path.dirname(forbidden),{recursive:true});
    await fs.writeFile(allowed,"{}");
    await fs.writeFile(forbidden,"{}");
    const records=[
      {key:"trae:one",state:"completed",executionHost:"macos",
        remoteTask:{jobId:"task-1",repository:"REVREBEL/linear-agents",projectId:"p1"}},
      {key:"trae:two",state:"completed",executionHost:"macos",
        inboxClearedAt:"previous",remoteTask:{jobId:"task-2"}},
      {key:"local:one",state:"completed",executionHost:"linux",taskFile:allowed},
      {key:"local:wrong",state:"completed",executionHost:"linux",taskFile:forbidden}
    ];
    const handle=createIssueCompletionRoute({
      sharedSecret:"bridge-test-secret",
      jobStore:{findByIssueId:async id=>{assert.equal(id,issueId);return records;},
        transition:async (...args)=>{transitions.push(args);}},
      cleanupMacTrae:async args=>{mac.push(args);},
      osxProjectsRoot:"/Users/rebel/projects",
    });
    const request=new PassThrough();
    request.method="POST";request.headers={authorization:"Bearer bridge-test-secret"};
    const response={status:null,body:null,writeHead(v){this.status=v;},end(v){this.body=JSON.parse(v);}};
    const pending=handle(request,response,{url:new URL("http://localhost/issue-completed")});
    request.end(JSON.stringify({issueId}));
    assert.equal(await pending,true);
    assert.equal(response.status,200);
    assert.deepEqual(response.body,{ok:true,issueId,cleaned:2});
    assert.equal(mac.length,1);
    assert.deepEqual(mac[0].job,{operation:"cleanup",agent:"trae",jobId:"task-1",
      repository:"REVREBEL/linear-agents",projectId:"p1",projectsRoot:"/Users/rebel/projects"});
    assert.equal(transitions.length,2);
    for(const [key,state,patch] of transitions){
      assert.equal(state,"completed");
      assert.ok(["trae:one","local:one"].includes(key));
      assert.ok(patch.inboxClearedAt);
    }
    await assert.rejects(fs.stat(allowed),{code:"ENOENT"});
    assert.equal((await fs.stat(forbidden)).isFile(),true);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test("P4 issue completion retains cleanup-before-ledger-transition ordering", async () => {
  let transitioned=false;
  const issueId="12345678-1234-1234-1234-123456789abc";
  const handle=createIssueCompletionRoute({
    sharedSecret:"test",osxProjectsRoot:"/Users/rebel/projects",
    jobStore:{findByIssueId:async()=>[{key:"trae:one",state:"completed",executionHost:"macos",
      remoteTask:{jobId:"task-1"}}],transition:async()=>{transitioned=true;}},
    cleanupMacTrae:async()=>{throw Error("remote cleanup not confirmed");}
  });
  const request=new PassThrough();request.method="POST";request.headers={authorization:"Bearer test"};
  const response={writeHead(){},end(){}};
  const pending=handle(request,response,{url:new URL("http://localhost/issue-completed")});
  request.end(JSON.stringify({issueId}));
  await assert.rejects(pending,/remote cleanup not confirmed/);
  assert.equal(transitioned,false);
});
test("P4 issue completion source retains unchanged main jobs route and job-store identity", async () => {
  const fs=await import("node:fs/promises");
  const src=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  assert.ok(src.includes('from "../bridge/issue-completion-route.mjs"'));
  assert.ok(src.includes('await handleIssueCompletionRoute(request, response, { url })'));
  assert.ok(src.includes('const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs")'));
  assert.ok(src.includes('request.method !== "POST" || url.pathname !== "/jobs"'));
  assert.ok(src.includes('const server = http.createServer(async (request, response) => {'));
});

test("P4 job admission scopes raw delivery IDs by agent while sanitizing task filenames", () => {
  const headers={"x-linear-webhook-id":"upstream:review/0001"};
  const a=identifyLinearJobDelivery({headers,rawBody:"{}",agent:"chatgpt-cli"});
  assert.deepEqual(a,{
    safeJobId:"upstream_review_0001",
    deliveryId:"upstream:review/0001",
    jobKey:"chatgpt-cli:upstream:review/0001",
  });
  const b=identifyLinearJobDelivery({headers,rawBody:"{}",agent:"chatgpt"});
  assert.equal(b.jobKey,"chatgpt:upstream:review/0001");
  assert.notEqual(a.jobKey,b.jobKey);
});
test("P4 job admission uses deterministic payload hash without upstream delivery ID", () => {
  const headers={};
  const options={headers,rawBody:'{"task":"same job"}',agent:"antigravity",
    now:()=>1234,randomUUID:()=>"uuid-1"};
  const a=identifyLinearJobDelivery(options);
  const b=identifyLinearJobDelivery({...options,now:()=>5678,randomUUID:()=>"uuid-2"});
  assert.equal(a.safeJobId,"job-1234-uuid-1");
  assert.equal(b.safeJobId,"job-5678-uuid-2");
  assert.match(a.deliveryId,/^[0-9a-f]{64}$/);
  assert.equal(a.deliveryId,b.deliveryId);
  assert.equal(a.jobKey,b.jobKey);
  assert.notEqual(a.jobKey,identifyLinearJobDelivery({...options,rawBody:"another body"}).jobKey);
});
test("P4 job admission fails closed on pending and failed duplicate deliveries", () => {
  assert.equal(linearJobDuplicateResponse({created:true}, "job-test", "host"),null);
  for(const state of ["claimed","received","unrouted","failed","interrupted"]){
    const result=linearJobDuplicateResponse({created:false,record:{state}},"job-test","agent.host");
    assert.equal(result.status,503);
    assert.deepEqual(result.body,{
      ok:false,accepted:false,duplicate:true,state,
      error:"Existing delivery was not accepted; inspect local job ledger before replay",
    });
  }
  const missing=linearJobDuplicateResponse({created:false,record:null},"job-test","agent.host");
  assert.equal(missing.status,503);
  assert.equal(missing.body.state,"claimed");
});
test("P4 accepted duplicate preserves 202 status and original job ID", () => {
  for(const state of ["queued","launching","running","awaiting_external","completed"]){
    const result=linearJobDuplicateResponse({created:false,record:{state,jobId:"existing-id"}},
      "new-id","agent.host");
    assert.deepEqual(result,{
      status:202,
      body:{ok:true,accepted:true,duplicate:true,jobId:"existing-id",state,host:"agent.host"}
    });
  }
});
test("P4 /jobs keeps authentication and preflight before durable delivery claim", async () => {
  const fs=await import("node:fs/promises");
  const src=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  const auth=src.indexOf('if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`)');
  const identity=src.indexOf("identifyLinearJobDelivery({");
  const preflight=src.indexOf("await preflightLinearJob({",identity);
  const claim=src.indexOf("const claimed = await jobStore.claim(",preflight);
  assert.ok(auth>=0 && auth<identity && identity<preflight && preflight<claim);
  const preflightSource=await fs.readFile(new URL("../jobs/job-preflight.mjs",import.meta.url),"utf8");
  const route=preflightSource.indexOf("const route = await resolveJobRoute(job)");
  const credentials=preflightSource.indexOf("const credential = route.ok ? await syncLinearCredential(",route);
  const readiness=preflightSource.indexOf('if (agent === "chatgpt-cli")',credentials);
  assert.ok(route>=0 && route<credentials && credentials<readiness);
  assert.match(src,/from "\.\.\/jobs\/job-admission\.mjs"/);
  assert.match(src,/from "\.\.\/jobs\/job-preflight\.mjs"/);
  assert.match(src,/const JOBS_DIR = path\.join\(PROJECT_DIR, "linear-jobs"\)/);
  assert.match(src,/const server = http\.createServer\(async \(request, response\) => \{/);
  const preparation=await fs.readFile(new URL("../jobs/local-task-preparation.mjs",import.meta.url),"utf8");
  assert.ok(preparation.includes('await jobStore.transition(jobKey, "queued"'));
  assert.ok(src.includes("await prepareLocalAgentTask({"));
});

test("P4 preflight preserves per-agent token synchronization and Mac non-persistence", async () => {
  const job={organizationId:"organization-1",completionUrl:"https://linear-trae.example/complete"};
  const trace=[];
  const inputs={job,agent:"trae",sharedSecret:"bridge-test",
    resolveJobRoute:async()=>{trace.push("route");return {ok:true,repositoryRoot:"/repo",executionHost:"macos"};},
    syncLinearCredential:async args=>{trace.push("credentials");assert.deepEqual(args,{
      agent:"trae",repositoryRoot:"/repo",organizationId:"organization-1",
      completionUrl:"https://linear-trae.example/complete",sharedSecret:"bridge-test",persist:false
    });return {accessToken:"mock-token"};},
    checkOpenCodeReady:async()=>{throw Error("must not check unrelated CLI");},
  };
  const result=await preflightLinearJob(inputs);
  assert.deepEqual(trace,["route","credentials"]);
  assert.equal(result.rejection,null);
  assert.equal(result.credential.accessToken,"mock-token");
  assert.equal(result.route.executionHost,"macos");
});
test("P4 preflight leaves failed token fetches retryable before durable claim", async () => {
  const trace=[];
  const args={job:{organizationId:"organization-2",completionUrl:"https://linear-ag.example/complete"},
    agent:"antigravity",sharedSecret:"secret",
    resolveJobRoute:async()=>{trace.push("route");return {ok:true,repositoryRoot:"/repo",executionHost:"linux"};},
    syncLinearCredential:async opts=>{trace.push("credentials");assert.equal(opts.persist,true);throw Error("token service offline");},
    checkOpenCodeReady:async()=>{trace.push("runtime");}
  };
  await assert.rejects(preflightLinearJob(args),/token service offline/);
  assert.deepEqual(trace,["route","credentials"]);
});
test("P4 preflight checks ChatGPT CLI runtime and rejects without durable claim", async () => {
  const trace=[];
  const args={job:{organizationId:"organization-3",payload:{data:{completionUrl:"https://linear-cli.example/complete"}}},
    agent:"chatgpt-cli",sharedSecret:"secret",
    resolveJobRoute:async()=>{trace.push("route");return {ok:true,repositoryRoot:"/repo",executionHost:"linux"};},
    syncLinearCredential:async opts=>{trace.push("credentials");assert.equal(opts.agent,"chatgpt-cli");return {accessToken:"test"};},
    checkOpenCodeReady:async()=>{trace.push("runtime");throw Error("not ready");}
  };
  const result=await preflightLinearJob(args);
  assert.deepEqual(trace,["route","credentials","runtime"]);
  assert.deepEqual(result.rejection,{status:503,body:{
    ok:false,accepted:false,error:"OpenCode ChatGPT runtime not ready: not ready"
  }});
});
test("P4 preflight keeps unrouted jobs eligible for ledger classification", async () => {
  let tokenCalls=0,readyCalls=0;
  const response=await preflightLinearJob({
    job:{organizationId:"test"},agent:"chatgpt-cli",sharedSecret:"secret",
    resolveJobRoute:async()=>({ok:false,error:"No project mapping"}),
    syncLinearCredential:async()=>{tokenCalls++;},
    checkOpenCodeReady:async()=>{readyCalls++;}
  });
  assert.equal(tokenCalls,0);
  assert.equal(readyCalls,1);
  assert.equal(response.route.ok,false);
  assert.equal(response.credential,null);
  assert.equal(response.rejection,null);
});

test("P4 local task preparation writes one canonical prompt, retains routing metadata and ordering", async () => {
  const fs=await import("node:fs/promises");
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr28-local-task-"));
  const calls=[];
  const job={routing:{project:"p1"},issueId:"issue-1",issueMetadata:{id:"issue-1",title:"Fix code"},
    source:"linear",sessionAction:"prompted",receivedAt:"now",organizationId:"org-1",
    agentSessionId:"session-1",completionUrl:"https://example.test/complete",
    payload:{data:{agentSessionId:"session-1",promptContext:"Original instruction",completionUrl:"https://example.test/complete"}}};
  const route={repositoryRoot:root,scopeKey:"scope-1",launchDirectory:root,
    projectScope:"scope-1",projectId:"project-1",initiativeId:"initiative-1",
    chatgptProjectUrl:"https://chatgpt.com/g/g-test",chatgptConversationMode:"new",
    chatgptAutoSend:true,agentRole:"coding",codeReviewRole:"review",
    agyConversationMode:"reuse-existing",agyConversationId:"conversation-1"};
  const activeTaskMemory={
    read:async(rootArg,id)=>{calls.push("read");assert.equal(rootArg,root);assert.equal(id,"issue-1");return {note:"safe checkpoint"};},
    recoveryPreamble:prior=>{calls.push("recovery");assert.equal(prior.note,"safe checkpoint");return "Resume safe checkpoint";},
    update:async(rootArg,id,patch)=>{calls.push("update");assert.equal(rootArg,root);assert.equal(id,"issue-1");
      assert.equal(patch.state,"active");assert.equal(patch.lastJobKey,"antigravity:delivery-1");},
  };
  const jobStore={transition:async(key,state,patch)=>{
    calls.push("queued");
    assert.equal(key,"antigravity:delivery-1");
    assert.equal(state,"queued");
    assert.equal(patch.issueId,"issue-1");
    assert.equal(patch.repositoryRoot,root);
    assert.equal(patch.workspace,root);
    assert.ok(patch.taskFile.endsWith("/delivery-1.json"));
  }};
  try{
    const result=await prepareLocalAgentTask({
      job,route,agent:"antigravity",jobKey:"antigravity:delivery-1",safeJobId:"delivery-1",
      jobStore,activeTaskMemory,
      drainProgressWrites:async()=>{calls.push("drain");},
      retrieveMemuMemory:async()=>{calls.push("memu");return "UNTRUSTED MEMORY SECRET INSTRUCTIONS";},
      extractDirectTask:value=>{calls.push("direct");return value;},
      extractPromptContext:value=>{calls.push("prompt");return value.payload.data.promptContext;},
      logger:{log:()=>{},warn:()=>{}},
    });
    const persisted=JSON.parse(await fs.readFile(result.filename,"utf8"));
    assert.deepEqual(calls,["drain","read","prompt","direct","recovery","memu","update","queued"]);
    assert.equal(result.workspace,root);
    assert.equal(result.routedJob.payload.data.promptContext,"Resume safe checkpoint\n\nOriginal instruction");
    assert.equal(persisted.payload.data.promptContext,result.routedJob.payload.data.promptContext);
    assert.equal(JSON.stringify(persisted).includes("UNTRUSTED MEMORY"),false);
    assert.equal(persisted.resolvedRouting.linearProjectId,"project-1");
    assert.equal(persisted.resolvedRouting.linearInitiativeId,"initiative-1");
    assert.equal(persisted.resolvedRouting.agyConversationId,"conversation-1");
    assert.equal(persisted.resolvedRouting.chatgptAutoSend,true);
    assert.equal((await fs.stat(result.filename)).mode&0o777,0o600);
    assert.equal((await fs.stat(path.dirname(result.filename))).mode&0o777,0o700);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("P4 local task preparation fails before queued transition on write or memory failure", async () => {
  const fs=await import("node:fs/promises");
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr28-local-failure-"));
  let queued=false;
  try{
    await assert.rejects(prepareLocalAgentTask({
      job:{issueId:"issue-2",payload:{data:{promptContext:"Task"}}},
      route:{repositoryRoot:root,scopeKey:"scope-2",launchDirectory:root},
      agent:"gemini",jobKey:"gemini:key",safeJobId:"job-2",
      jobStore:{transition:async()=>{queued=true;}},
      activeTaskMemory:{read:async()=>{throw Error("memory unavailable");},
        recoveryPreamble:()=>"",update:async()=>{}},
      drainProgressWrites:async()=>{},
      retrieveMemuMemory:async()=>"",
      extractDirectTask:v=>v,
      extractPromptContext:v=>v.payload?.data?.promptContext,
      logger:{log:()=>{},warn:()=>{}}
    }),/memory unavailable/);
    assert.equal(queued,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("P4 local task preparation preserves bridge-owned launches and runtime job root", async () => {
  const fs=await import("node:fs/promises");
  const bridge=await fs.readFile(new URL("../linear-agent-bridge/agent-bridge.mjs",import.meta.url),"utf8");
  const from=bridge.indexOf("await prepareLocalAgentTask({");
  const launched=bridge.indexOf('await jobStore.transition(jobKey, "launching"',from);
  assert.ok(from>=0&&launched>from);
  assert.ok(bridge.includes('from "../jobs/local-task-preparation.mjs"'));
  assert.ok(bridge.includes('const JOBS_DIR = path.join(PROJECT_DIR, "linear-jobs")'));
  assert.ok(bridge.includes('const server = http.createServer(async (request, response) => {'));
  assert.ok(bridge.includes('await startGemini(routedJob, filename, workspace, jobKey, credential)'));
});
