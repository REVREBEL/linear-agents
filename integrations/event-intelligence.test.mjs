import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createGithubWebhookRoutes } from "../bridge/handlers/github-webhook-routes.mjs";
import { normalizeVerifiedGithubEvent, normalizeVerifiedLinearEvent,
  classifyEventIntelligence, semanticReviewWorkKey,
  recordEventIntelligenceShadow } from "./event-intelligence.mjs";

const SHA = "a".repeat(40);
const repo = "REVREBEL/linear-agents";
const github = (overrides = {}) => normalizeVerifiedGithubEvent({
  delivery: "delivery-0001", event: "pull_request", action: "opened",
  repository: repo, number: 285, headSha: SHA, installationId: 847,
  actorLogin: "trae-reviewer", actorId: 1234, prAuthorLogin: "trae-coding", ...overrides,
}, "antigravity");
const linear = props => normalizeVerifiedLinearEvent({
  deliveryId: "linear-0001", eventType: "Linear.AppUserNotification",
  organizationId: "dcedfdda-3793-4c5f-aa63-703897e9618b", ...props,
});
const classify = (event, evidence) => classifyEventIntelligence(event, evidence);

test("T-01: signed-context Linear notification without prompt is held for enrichment", () => {
  const target = linear({issueId: "4e6f0921-aa4d-402e-baa6-91641edb821a"});
  assert.equal(target.hasPromptContext, false);
  assert.deepEqual(classify(target).decision, "defer");
  assert.equal(classify(target).reason, "missing-prompt-enrich-linked-notification");
  assert.equal(classify(linear({})).decision, "ignore");
  assert.equal(classify(linear({prNumber: 7, repository: repo})).decision, "defer");
  assert.throws(() => linear({issueId: "../unsafe"}), /Invalid verified Linear event/);
  assert.throws(() => linear({eventType: "malicious"}), /Invalid verified Linear event/);
});

test("T-02 / T-03: Renovate routinely ignored, verified security evidence deferred", () => {
  const event = github({actorLogin: "human-maintainer", actorId: 205,
    prAuthorLogin: "renovate[bot]"});
  assert.equal(event.actor.login,"human-maintainer");
  assert.equal(event.target.prAuthorLogin,"renovate[bot]");
  assert.equal(classify(event).reason, "routine-renovate-no-verified-security-evidence");
  assert.equal(classify(event).decision, "ignore");
  assert.deepEqual(
    [classify(event, {verifiedSecurityAdvisory:true}).decision,
      classify(event, {verifiedSecurityAdvisory:true}).intent],
    ["defer", "dependency_security"]);
  assert.equal(classify(event, {verifiedSecurityAdvisory:true}).priority, "high");
  // Bot *sender* on a human PR is not evidence that the PR was authored by Renovate.
  assert.equal(classify(github({actorLogin:"renovate[bot]",prAuthorLogin:"human-dev"})).decision,"defer");
  assert.equal(classify(github({actorLogin:"renovate[bot]",prAuthorLogin:"human-dev"}),{
    verifiedCi:"success",authorizedReviewRoute:true}).decision,"dispatch");
  assert.equal(classify(github({actorLogin:"renovate[bot]",prAuthorLogin:null}),{
    verifiedCi:"success",authorizedReviewRoute:true}).decision,"defer");
  // Even on Renovate PRs, comments require substantive verification first.
  assert.equal(classify(github({event:"issue_comment",action:"created",
    actorLogin:"sourcery-ai[bot]",prAuthorLogin:"renovate[bot]"})).decision,
    "needs_human_review");
});

test("T-04/T-05: bot findings are not automatically discarded or launched", () => {
  const comment = normalizeVerifiedGithubEvent({event:"issue_comment",action:"created",
    delivery:"comment-001",repository:repo,number:285,headSha:null,
    commentBody:"Please fix an actual concurrency error",author:"sourcery-ai[bot]",
    authorType:"Bot",commentId:122},"chatgpt");
  assert.equal(classify(comment).decision, "needs_human_review");
  assert.equal(classify(comment).intent, "implementation_followup");
  assert.equal(semanticReviewWorkKey(comment), null);
  assert.equal(comment.contentHash.length,64);
  assert.equal(JSON.stringify(comment).includes("concurrency error"),false);
});

test("T-06: self-authored reviewer events never trigger review", () => {
  assert.equal(classify(github(),{selfIds:["1234"]}).reason,"self-authored-event");
  assert.equal(classify(github({actorId:null,actorLogin:"chatgpt-review[bot]"}),
    {selfLogins:["CHATGPT-REVIEW[BOT]"]}).decision,"ignore");
  assert.equal(classify(github({actorId:99}),{selfIds:["1234"]}).decision,"defer");
});

test("T-07: semantic work keys differ from deliveries and review cycles", () => {
  const first = github(), retry = github({delivery:"delivery-0002"});
  const base = semanticReviewWorkKey(first,{reviewCycle:0,findingFingerprint:"fix-one"});
  assert.match(base,/^[a-f0-9]{64}$/);
  assert.equal(base,semanticReviewWorkKey(retry,{reviewCycle:0,findingFingerprint:"fix-one"}));
  assert.notEqual(base,semanticReviewWorkKey(first,{reviewCycle:1,findingFingerprint:"fix-one"}));
  assert.notEqual(base,semanticReviewWorkKey(first,{reviewCycle:0,findingFingerprint:"fix-two"}));
  assert.notEqual(base,semanticReviewWorkKey(github({installationId:848}),
    {reviewCycle:0,findingFingerprint:"fix-one"}));
  assert.equal(semanticReviewWorkKey(github({headSha:null})),null);
  assert.equal(semanticReviewWorkKey(github({installationId:null})),null);
});

test("T-08: PR text cannot authorize an unsafe dispatch", () => {
  const incoming = github();
  assert.equal(classify(incoming).decision,"defer");
  assert.equal(classify(incoming,{verifiedCi:"success"}).decision,"defer");
  assert.equal(classify(incoming,{authorizedReviewRoute:true}).decision,"defer");
  assert.equal(classify(incoming,{verifiedCi:"success",authorizedReviewRoute:true}).decision,"dispatch");
  assert.equal(classify(incoming,{verifiedCi:"success",authorizedReviewRoute:true,
    alreadyReviewed:true}).decision,"ignore");
  assert.equal(classify(github({action:"synchronize"}),{
    verifiedCi:"success",authorizedReviewRoute:true}).decision,"defer");
});

test("T-09: unsupported events and invalid targets fail bounded and safely", () => {
  assert.equal(classify(github({action:"edited"})).decision,"ignore");
  assert.throws(()=>normalizeVerifiedGithubEvent({event:"evil",delivery:"delivery-001"},"chatgpt"),
    /Invalid verified GitHub event/);
  assert.throws(()=>github({headSha:"not-a-commit"}), /Invalid GitHub head SHA/);
  assert.throws(()=>github({repository:"../escape"}), /Missing verified GitHub target/);
});

test("shadow record stores metadata only and deduplicates exact delivery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"abr18-shadow-"));
  try {
    const event = github({delivery:"shadow-0001"});
    const result = classify(event);
    const first = await recordEventIntelligenceShadow(root,event,result);
    assert.equal(first.duplicate,false);
    const mode = (await fs.stat(first.path)).mode & 0o777;
    assert.equal(mode,0o600);
    const saved = JSON.parse(await fs.readFile(first.path,"utf8"));
    assert.equal(saved.dispatched,false);
    assert.equal(saved.state,"shadow-only");
    assert.equal(saved.decision,"defer");
    assert.equal(saved.semanticWorkKey,semanticReviewWorkKey(event));
    assert.equal(saved.deliveryHash.length,64);
    assert.equal(saved.actorLogin,"trae-reviewer");
    assert.equal(saved.source,undefined);
    assert.equal((await recordEventIntelligenceShadow(root,event,result)).duplicate,true);
    const changed = github({delivery:"shadow-0001",headSha:"b".repeat(40)});
    await assert.rejects(recordEventIntelligenceShadow(root,changed,classify(changed)),
      /collision or corrupt receipt/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("authenticated Bridge ingress writes shadow decision only when opted-in", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"abr18-route-"));
  const raw = {event:"pull_request",delivery:"live-0001",payload:{
    action:"opened", repository:{full_name:repo},sender:{login:"trae-reviewer",id:7},
    installation:{id:847},pull_request:{number:285,user:{login:"trae-coding"},html_url:
      "https://github.com/REVREBEL/linear-agents/pull/285",
      head:{sha:SHA},draft:false}}};
  const log = [];
  const handler = createGithubWebhookRoutes({
    sharedSecret:"test-only-secret",jobsDir:root,linearApiKey:"",
    selfIdentity:{ids:[],logins:[]},githubTaskMemory:{update:async()=>{}},
    claimGithubReviewDispatch:async()=>null,
    launchGithubShortcutHandoff:()=>{throw Error("must not launch shadow");},
    platform:"linux",env:{CHATGPT_REVIEW_MODE:"inbox",
      CHATGPT_REVIEW_INBOX_TOKEN:"z".repeat(40),EVENT_INTELLIGENCE_MODE:"shadow"},
    logger:{log:(...args)=>log.push(args),warn:(...args)=>log.push(args)},
  });
  async function request(secret,delivery) {
    const req = new PassThrough(); req.method="POST";
    req.headers={authorization:"Bearer "+secret,"x-github-agent":"chatgpt"};
    const res = {status:null,body:null,writeHead(code){this.status=code},
      end(text){this.body=JSON.parse(text)}};
    const pending = handler(req,res,{url:new URL("http://localhost/github/events")});
    req.end(JSON.stringify({...raw,delivery}));
    await pending; return res;
  }
  try {
    assert.equal((await request("wrong","live-0000")).status,401);
    await assert.rejects(fs.stat(path.join(root,"event-intelligence")),{code:"ENOENT"});
    const accepted = await request("test-only-secret","live-0001");
    assert.equal(accepted.status,202);
    assert.equal(accepted.body.accepted,true);
    const files=await fs.readdir(path.join(root,"event-intelligence","shadow"));
    assert.equal(files.length,1);
    const item=JSON.parse(await fs.readFile(path.join(root,"event-intelligence","shadow",files[0]),"utf8"));
    assert.equal(item.state,"shadow-only");assert.equal(item.decision,"defer");
    assert.equal(log.some(args=>args[0]==="ABR-18 shadow triage"),true);
    const duplicate=await request("test-only-secret","live-0001");
    assert.equal(duplicate.body.duplicate,true);
    assert.equal((await fs.readdir(path.join(root,"event-intelligence","shadow"))).length,1);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
