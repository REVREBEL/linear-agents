import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createLinearOAuthLifecycle,discoverLinearOAuthIdentity} from "./linear-oauth-lifecycle.mjs";

const actorId="00000000-0000-4000-8000-000000000001",workspaceId="00000000-0000-4000-8000-000000000002";
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
async function fixture(fn,overrides={}){
  const root=await fs.mkdtemp(path.join(os.homedir(),".linear-oauth-test-"));
  const cache=path.join(root,"linear-oauth.token");
  let time=Date.now(),issued=0,invalid=new Set(),evidenceCalls=0;
  const fetchImpl=async(url,options)=>{
    assert.equal(options.method,"POST");assert.equal(options.redirect,"error");
    if(url==="https://api.linear.app/oauth/token"){
      const params=Object.fromEntries(new URLSearchParams(options.body));
      assert.equal(params.grant_type,"client_credentials");assert.equal(params.scope,"read");
      assert.equal(params.client_id,"synthetic-client-id");
      assert.ok(["synthetic-client-secret","synthetic-client-rotated"].includes(params.client_secret));
      issued++;
      return response({access_token:"synthetic-access-"+issued,scope:"read",token_type:"Bearer",expires_in:2591999,...overrides});
    }
    assert.equal(url,"https://api.linear.app/graphql");
    const token=options.headers.Authorization.slice(7);
    if(invalid.has(token))return response({},401);
    const body=JSON.parse(options.body);
    if(body.query.includes("BridgeAuthorityIdentity")||body.query.includes("BridgeAuthorityBootstrap"))return response({data:{viewer:{id:actorId,name:"Memory Authority"},organization:{id:workspaceId,name:"Synthetic Workspace"}}});
    evidenceCalls++;
    return response({data:{issue:{id:"synthetic-issue"}}});
  };
  const args={root,actorId,workspaceId,fetchImpl,now:()=>time};
  try{
    await fs.writeFile(path.join(root,"linear-client.id"),"synthetic-client-id",{mode:0o600});
    await fs.writeFile(path.join(root,"linear-client.secret"),"synthetic-client-secret",{mode:0o600});
    await fn({args,cache,root,advance:ms=>{time+=ms;},issued:()=>issued,invalid,evidenceCalls:()=>evidenceCalls});
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
test("initial issue, private atomic cache, restart reuse, automatic pre-expiry replacement",async()=>fixture(async f=>{
  const a=createLinearOAuthLifecycle(f.args);
  assert.equal(await a.getToken(),"synthetic-access-1");
  assert.equal((await fs.stat(f.cache)).mode&0o777,0o600);
  assert.equal(await createLinearOAuthLifecycle(f.args).getToken(),"synthetic-access-1");
  f.advance(29*86400000);
  assert.equal(await a.getToken(),"synthetic-access-2");
  assert.equal(f.issued(),2);
}));
test("same-process concurrent providers share a single issuance",async()=>fixture(async f=>{
  const tokens=await Promise.all(Array.from({length:10},()=>createLinearOAuthLifecycle(f.args).getToken()));
  assert.equal(new Set(tokens).size,1);assert.equal(f.issued(),1);
}));
test("early revocation on identity and completion retry rotate once",async()=>fixture(async f=>{
  const a=createLinearOAuthLifecycle(f.args);
  const first=await a.getToken();
  f.invalid.add(first);
  const second=await a.getToken();
  assert.notEqual(second,first);
  const opts={method:"POST",redirect:"error",headers:{Authorization:"Bearer "+second,"Content-Type":"application/json"},body:JSON.stringify({query:"query ReadIssue { issue { id } }"})};
  f.invalid.add(second);
  const result=await a.fetchGraphQL("https://api.linear.app/graphql",opts);
  assert.equal(result.status,200);assert.equal(f.issued(),3);assert.equal(f.evidenceCalls(),1);
}));
test("client-secret rotation invalidates cached token without manual replacement",async()=>fixture(async f=>{
  const a=createLinearOAuthLifecycle(f.args);
  await a.getToken();
  await fs.writeFile(path.join(f.root,"linear-client.secret"),"synthetic-client-rotated");
  assert.equal(await a.getToken(),"synthetic-access-2");
}));
test("missing/insecure credentials or cache fail closed; raw legacy token is not reused",async()=>fixture(async f=>{
  const a=createLinearOAuthLifecycle(f.args);
  await fs.writeFile(f.cache,"legacy-manual-token",{mode:0o600});
  assert.equal(await a.getToken(),"synthetic-access-1");
  await fs.chmod(f.cache,0o644);
  await assert.rejects(a.getToken(),/rejected/);
  await fs.chmod(f.cache,0o600);
  await fs.unlink(path.join(f.root,"linear-client.secret"));
  await assert.rejects(a.getToken(),/rejected/);
  assert.equal(f.issued(),1);
}));
test("overprivileged, invalid expiry and rejected actor never enter cache",async()=>{
  for(const bad of [{scope:"read write"},{expires_in:0},{expires_in:2592001},{token_type:"Other"}]){
    await fixture(async f=>{
      await assert.rejects(createLinearOAuthLifecycle(f.args).getToken(),/rejected/);
      await assert.rejects(fs.stat(f.cache),{code:"ENOENT"});
    },bad);
  }
  await fixture(async f=>{
    await assert.rejects(createLinearOAuthLifecycle({...f.args,actorId:"wrong"}).getToken(),/rejected/);
    await assert.rejects(fs.stat(f.cache),{code:"ENOENT"});
  });
});
test("second HTTP 401 is not retried indefinitely",async()=>fixture(async f=>{
  let issueCalls=0;
  const fetchImpl=async(url,opts)=>{
    if(url==="https://api.linear.app/graphql"&&!JSON.parse(opts.body).query.includes("BridgeAuthorityIdentity")){
      issueCalls++;return response({},401);
    }
    return f.args.fetchImpl(url,opts);
  };
  const a=createLinearOAuthLifecycle({...f.args,fetchImpl}),token=await a.getToken();
  const res=await a.fetchGraphQL("https://api.linear.app/graphql",{method:"POST",redirect:"error",headers:{Authorization:"Bearer "+token},body:JSON.stringify({query:"query ReadIssue { issue { id } }"})});
  assert.equal(res.status,401);assert.equal(issueCalls,2);assert.equal(f.issued(),2);
}));

test("bootstrap returns only independently workspace-matched candidate identity",async()=>fixture(async f=>{
  const result=await discoverLinearOAuthIdentity({root:f.root,expectedWorkspaceId:workspaceId,fetchImpl:f.args.fetchImpl});
  assert.deepEqual(result,{workspaceId,workspaceName:"Synthetic Workspace",actorId,actorName:"Memory Authority",scope:"read"});
  await assert.rejects(fs.stat(f.cache),{code:"ENOENT"});
  await assert.rejects(discoverLinearOAuthIdentity({root:f.root,expectedWorkspaceId:actorId,fetchImpl:f.args.fetchImpl}),/rejected/);
  await assert.rejects(fs.stat(f.cache),{code:"ENOENT"});
}));

test("401 recovery gives the original read-only query a fresh bounded signal after renewal",async()=>fixture(async f=>{
  const controller=new AbortController();
  let queryCalls=0,renewalStarted=false;
  const body=JSON.stringify({query:"query ReadIssue($id:String!) { issue(id:$id) { id } }",variables:{id:"ABR-59"}});
  const fetchImpl=async(url,opts)=>{
    if(url==="https://api.linear.app/oauth/token"&&f.issued()===1){
      renewalStarted=true;
      controller.abort(new DOMException("Original request timed out during renewal","TimeoutError"));
    }
    if(url==="https://api.linear.app/graphql"&&opts.body===body){
      queryCalls++;
      if(queryCalls===1){
        assert.equal(opts.signal,controller.signal);
        assert.equal(opts.signal.aborted,false);
        return response({},401);
      }
      assert.equal(renewalStarted,true);
      assert.equal(controller.signal.aborted,true);
      assert.notEqual(opts.signal,controller.signal);
      assert.equal(opts.signal.aborted,false);
      assert.equal(opts.headers.Authorization,"Bearer synthetic-access-2");
      assert.equal(opts.redirect,"error");
      opts.signal.throwIfAborted();
    }
    return f.args.fetchImpl(url,opts);
  };
  const a=createLinearOAuthLifecycle({...f.args,fetchImpl}),token=await a.getToken();
  const result=await a.fetchGraphQL("https://api.linear.app/graphql",{method:"POST",redirect:"error",headers:{Authorization:"Bearer "+token},body,signal:controller.signal});
  assert.equal(result.status,200);assert.equal(queryCalls,2);assert.equal(f.issued(),2);
}));
