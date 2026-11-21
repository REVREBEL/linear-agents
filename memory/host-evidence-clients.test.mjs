import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createHostEvidenceClients } from "./host-evidence-clients.mjs";
import { verifyPromotionFromGitHub } from "./promotion-verification.mjs";
const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const repositoryId="REVREBEL/linear-agents", sha="a".repeat(40);
const job={jobId:"test",scope:{tenantId:id(1),agentId:"qwen",repositoryId,issueId:"ABR-59"},prNumber:254,headSha:sha};
const config={repositoryId,repositoryNumericId:10,githubAppId:20,installationId:30,linearWorkspaceId:id(1),linearActorId:id(2),linearTeamId:id(3)};
const permitted={metadata:"read",pull_requests:"read",checks:"read",contents:"read"};
const testToken="synthetic-token-no-network";
const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
const pr={number:254,merged:true,state:"closed",merge_commit_sha:"b".repeat(40),
  head:{sha,repo:{full_name:repositoryId}},base:{repo:{full_name:repositoryId}},user:{login:"author"}};
const response=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{"Content-Type":"application/json"}});
async function fixture(fn,overrides={}){
  const root=await fs.mkdtemp(path.join(os.homedir(),".abr59-evidence-"));
  try{
    await fs.writeFile(path.join(root,"evidence.json"),JSON.stringify(config),{mode:0o600});
    await fs.writeFile(path.join(root,"github-app.pem"),privateKey,{mode:0o600});
    await fs.writeFile(path.join(root,"linear-client.id"),"synthetic-client-id",{mode:0o600});
    await fs.writeFile(path.join(root,"linear-client.secret"),"synthetic-client-secret",{mode:0o600});
    const calls=[];
    const fetchImpl=async(url,opts)=>{
      const u=new URL(url),body=opts.body?(u.pathname==="/oauth/token"?Object.fromEntries(new URLSearchParams(opts.body)):JSON.parse(opts.body)):null;
      calls.push({u,method:opts.method,body});
      assert.equal(opts.redirect,"error");
      if(u.origin==="https://api.linear.app"){
        if(u.pathname==="/oauth/token"){
          assert.deepEqual(body,{grant_type:"client_credentials",scope:"read",client_id:"synthetic-client-id",client_secret:"synthetic-client-secret"});
          return response({access_token:testToken,token_type:"Bearer",scope:"read",expires_in:2591999});
        }
        assert.equal(opts.headers.Authorization,"Bearer "+testToken);
        if(body.query.includes("BridgeAuthorityIdentity"))return response({data:{viewer:{id:id(2)},organization:{id:overrides.workspace??id(1)}}});
        return response({data:{issue:{id:id(4),identifier:"ABR-59",completedAt:"2026-11-20T00:00:00Z",archivedAt:null,state:{type:"completed"},team:{id:id(3)},attachments:{nodes:[{url:"https://github.com/"+repositoryId+"/pull/254"}],pageInfo:{hasNextPage:false,endCursor:null}}}}});
      }
      assert.equal(u.origin,"https://api.github.com");
      if(u.pathname.endsWith("/installation"))return response({id:overrides.installation??30,app_id:20,account:{login:"REVREBEL"},suspended_at:null});
      if(u.pathname.endsWith("/access_tokens")){
        assert.deepEqual(body,{repository_ids:[10],permissions:permitted});
        assert.equal(opts.method,"POST");
        return response({token:testToken,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:overrides.permissions??permitted},201);
      }
      assert.equal(opts.method,"GET");
      assert.equal(opts.headers.Authorization,"Bearer "+testToken);
      if(u.pathname==="/installation/repositories")return response({total_count:1,repositories:[{id:10,full_name:repositoryId}]});
      if(u.pathname.endsWith("/pulls/254"))return response(pr);
      if(u.pathname.endsWith("/reviews"))return response([{id:1,user:{login:"reviewer"},state:"APPROVED",commit_id:sha,submitted_at:"2026-11-20T00:00:00Z"}]);
      if(u.pathname.endsWith("/check-runs"))return response({total_count:1,check_runs:[{name:"ci",id:1,head_sha:sha,app:{slug:"github-actions"},status:"completed",conclusion:"success"}]});
      if(u.pathname.endsWith("/permission"))return response({permission:"write"});
      throw Error("Unexpected mock endpoint");
    };
    await fn({root,job,fetchImpl},calls);
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
test("pins app installation, single repo read scope, Linear workspace/actor/team and reviewed SHA",async()=>fixture(async(args,calls)=>{
  const {github,linear}=await createHostEvidenceClients(args);
  const proof=await verifyPromotionFromGitHub({github,scope:job.scope,prNumber:254,expectedHeadSha:sha,
    requiredChecks:["ci"],allowedCheckApps:["github-actions"],permittedReviewers:["reviewer"]});
  assert.equal(proof.status,"verified-after-merge");
  assert.equal((await linear.getIssue("ABR-59")).statusType,"completed");
  assert.throws(()=>github.getPullRequest("FOREIGN/repo",254),/rejected/);
  assert.throws(()=>linear.getIssue("ABR-60"),/rejected/);
  assert.equal(calls.filter(c=>c.u.pathname.endsWith("/access_tokens")).length,1);
}));
test("wrong GitHub installation or overprivileged token rejects before any evidence reads",async()=>{
  for(const bad of [{installation:99},{permissions:{...permitted,contents:"write"}}])await fixture(async args=>{
    const {github}=await createHostEvidenceClients(args);
    await assert.rejects(github.getPullRequest(repositoryId,254),/unavailable/);
  },bad);
});
test("wrong Linear workspace and foreign tenant fail closed",async()=>fixture(async args=>{
  const {linear}=await createHostEvidenceClients(args);
  await assert.rejects(linear.getIssue("ABR-59"),/unavailable/);
  await assert.rejects(createHostEvidenceClients({...args,job:{...job,scope:{...job.scope,tenantId:id(99)}}}),/rejected/);
},{workspace:id(99)}));
test("agent-readable evidence credentials are refused",async()=>fixture(async args=>{
  await fs.chmod(path.join(args.root,"github-app.pem"),0o644);
  const {github}=await createHostEvidenceClients(args);
  await assert.rejects(github.getPullRequest(repositoryId,254),/unavailable/);
}));
