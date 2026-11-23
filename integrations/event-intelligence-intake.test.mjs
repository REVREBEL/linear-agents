import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateNoPromptIntake, persistNoPromptIntake } from "./event-intelligence-intake.mjs";
import { createEventIntelligenceIntakeRoute } from "../bridge/handlers/event-intelligence-intake-route.mjs";
import { createHttpRouteComposer } from "../bridge/server/http-route-composition.mjs";

const digest = "a".repeat(64);
const org = "dcedfdda-3793-4c5f-aa63-703897e9618b";
const issueId = "1f982fb0-d74b-46d2-b7c9-d6d94e723937";
const intake = (extra = {}) => ({
  schemaVersion: 2, provider: "linear", eventType: "Linear.AppUserNotification",
  deliveryId: "event:" + digest, signedPayloadSha256: digest,
  workerIdentity: "linear-chatgpt-agent", organizationId: org, issueId,
  agentSessionId: null, hasPromptContext: false,
  prCandidate: { repository: "REVREBEL/linear-agents", number: 289 },
  verifiedIssue: { id: issueId, identifier: "ABR-18", organizationId: org,
    projectId: "ef1bf601-dfbb-467a-96bb-7388f5a67b8d", stateType: "started" },
  ...extra,
});

test("typed no-prompt receipt separates verified Linear facts from unverified GitHub PR", () => {
  const result = validateNoPromptIntake(intake());
  assert.equal(result.stage, "awaiting_verified_github_evidence");
  assert.equal(result.classification.decision, "defer");
  assert.equal(result.dispatchStatus, "not_started");
  assert.equal(result.reviewLaunchStatus, "not_started");
  assert.equal(result.verifiedIssue.organizationId, org);
  assert.equal(result.prCandidate.number, 289);
  assert.equal(result.githubEvidence, undefined);
  assert.equal(validateNoPromptIntake(intake({prCandidate:null})).stage,"awaiting_verified_pr_link");
  assert.equal(validateNoPromptIntake(intake({verifiedIssue:null})).stage,"awaiting_verified_linear_issue");
  assert.equal(validateNoPromptIntake(intake({issueId:null,verifiedIssue:null,prCandidate:null})).stage,
    "awaiting_issue_link");
});

test("strict validation refuses untrusted scope, hashes, identities, and routing claims", () => {
  const invalid = [
    {organizationId:"../escape"}, {workerIdentity:"linear-antigravity-agent"},
    {hasPromptContext:true}, {signedPayloadSha256:"b".repeat(64)},
    {issueId:"../issue"}, {verifiedIssue:{...intake().verifiedIssue,organizationId:"other"}},
    {verifiedIssue:{...intake().verifiedIssue,id:"another-issue-id"}},
    {prCandidate:{repository:"../evil",number:1}},
    {prCandidate:{repository:"REVREBEL/linear-agents",number:-2}},
    {verifiedIssue:{...intake().verifiedIssue,identifier:"Invalid issue"}},
    {agentSessionId:"../etc"},
  ];
  for(const patch of invalid) assert.throws(()=>validateNoPromptIntake(intake(patch)),
    /Invalid|Unlinked/);
});

test("fsynced receipt dedupes the signed delivery and rejects changed metadata", async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"abr18-intake-store-"));
  try {
    const first=await persistNoPromptIntake(dir,intake());
    assert.equal(first.duplicate,false);
    assert.equal(first.stage,"awaiting_verified_github_evidence");
    const receipt=path.join(dir,"event-intelligence","linear-intake",first.deliveryHash+".json");
    assert.equal((await fs.stat(receipt)).mode&0o777,0o600);
    const saved=JSON.parse(await fs.readFile(receipt,"utf8"));
    assert.equal(saved.durable,true);
    assert.equal(saved.dispatched,false);
    assert.equal(saved.reviewLaunchStatus,"not_started");
    assert.equal(saved.providerFactsVerifiedBy,"linear-oauth-app");
    assert.equal(saved.githubEvidence,"not_verified");
    assert.equal(saved.signedPayloadSha256,digest);
    assert.equal((await persistNoPromptIntake(dir,intake())).duplicate,true);
    await assert.rejects(persistNoPromptIntake(dir,intake({
      prCandidate:{repository:"REVREBEL/linear-agents",number:290},
    })),/collision or tampering/);
    assert.equal((await fs.readdir(path.dirname(receipt))).length,1);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test("private bridge intake refuses wrong method, disabled flag, and bad bearer/identity", async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"abr18-intake-auth-"));
  let saves=0;
  const env={EVENT_INTELLIGENCE_MODE:"shadow"};
  const handler=createEventIntelligenceIntakeRoute({
    jobsDir:dir,intakeToken:"separate-reviewer-intake-secret-for-phase2",env,
    bodyReader:async req=>req.body,logger:{warn(){}},
    persist:async(...args)=>{saves++;return persistNoPromptIntake(...args);},
  });
  async function request(method="POST",headers={},body=JSON.stringify(intake())) {
    const response={status:null,result:null,headers:{},
      setHeader(name,val){this.headers[name]=val}};
    const send=(r,status,result)=>{r.status=status;r.result=result;};
    // Underlying route uses the real sendJson primitive, so supply an HTTP-like response.
    response.writeHead=function(status){this.status=status};
    response.end=function(text){this.result=JSON.parse(text)};
    const handled=await handler({method,headers,body},response,{
      url:new URL("http://bridge.test/event-intelligence/intake")});
    return {...response,handled};
  }
  const auth={authorization:"Bearer separate-reviewer-intake-secret-for-phase2",
    "x-bridge-worker":"linear-chatgpt-agent"};
  try {
    assert.equal((await request("GET")).status,405);
    assert.equal((await request("POST")).status,401);
    assert.equal((await request("POST",{...auth,authorization:"Bearer wrong"})).status,401);
    assert.equal((await request("POST",{...auth,
      authorization:"Bearer shared-jobs-secret-even-if-long-enough"})).status,401);
    assert.equal((await request("POST",{...auth,"x-bridge-worker":"linear-other-agent"})).status,401);
    env.EVENT_INTELLIGENCE_MODE="off";
    assert.equal((await request("POST",auth)).status,503);
    // Disabled and unconfigured routes must not claim review progress.
    env.EVENT_INTELLIGENCE_MODE="shadow";
    assert.equal((await request("POST",auth,"{")).status,400);
    assert.equal((await request("POST",auth,JSON.stringify(intake({issueId:"bad"})))).status,422);
    assert.equal(saves,1);
    const accepted=await request("POST",auth);
    assert.equal(accepted.status,202);
    assert.equal(accepted.result.durable,true);
    assert.equal(accepted.result.dispatchStatus,"not_started");
    assert.equal(accepted.result.reviewLaunchStatus,"not_started");
    assert.equal(accepted.result.duplicate,false);
    const repeat=await request("POST",auth);
    assert.equal(repeat.status,202);
    assert.equal(repeat.result.duplicate,true);
    assert.equal(saves,3);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("composition keeps existing route order and delegates protected intake before GitHub", async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"abr18-intake-compose-"));
  const events=[];
  const composer=createHttpRouteComposer({
    jobsDir:dir,readBody:async req=>req.body,logger:{warn(){}},
    sendJson:(res,status,body)=>{
      res.status=status;res.body=body;
    },intakeToken:"separate-reviewer-intake-secret-for-phase2",env:{EVENT_INTELLIGENCE_MODE:"shadow"},
    handleDiagnosticRoute:()=>{events.push("diag");return false},
    handleReviewRoute:()=>{events.push("review");return false},
    handleGithubWebhookRoute:()=>{events.push("github");return false},
    handleTraeCallbackRoute:()=>{events.push("trae");return false},
    handleIssueCompletionRoute:()=>{events.push("issue");return false},
  });
  try {
    const request={method:"POST",headers:{
      authorization:"Bearer separate-reviewer-intake-secret-for-phase2","x-bridge-worker":"linear-chatgpt-agent"},
      body:JSON.stringify(intake())};
    const response={status:null,body:null,
      writeHead(status){this.status=status},
      end(text){this.body=JSON.parse(text)},
    };
    assert.equal(await composer(request,response,{
      host:"bridge.test",url:new URL("http://bridge.test/event-intelligence/intake")}),true);
    assert.equal(response.status,202);
    assert.equal(response.body.accepted,true);
    assert.equal(response.body.reviewLaunchStatus,"not_started");
    assert.deepEqual(events,["diag"]);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
