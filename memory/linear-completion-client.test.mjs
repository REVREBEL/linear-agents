import test from "node:test";
import assert from "node:assert/strict";
import { createLinearCompletionClient } from "./linear-completion-client.mjs";
const repo="REVREBEL/linear-agents", sha="a".repeat(40);
const teamId="92abb618-f616-4522-8db9-054833f82cce";
const uuid="1374b698-d8e0-48df-a075-abe5abc4ccef";
const url="https://github.com/"+repo+"/pull/261";
const issue={id:uuid,identifier:"ABR-59",team:{id:teamId},state:{type:"completed"},
  completedAt:"2026-11-20T00:00:00Z",archivedAt:null,
  attachments:{nodes:[{url}],pageInfo:{hasNextPage:false,endCursor:null}}};
const pr={number:261,state:"closed",merged:true,head:{sha,repo:{full_name:repo}},
  base:{repo:{full_name:repo}}};
const token="test-linear-token-not-real";
function fixture({respond=()=>issue,github={getPullRequest:async()=>pr},...opts}={}){
  const calls=[];
  const client=createLinearCompletionClient({teamId,repositoryId:repo,prNumber:261,
    headSha:sha,tokenProvider:async()=>token,github,
    fetchImpl:async(endpoint,options)=>{
      assert.equal(endpoint,"https://api.linear.app/graphql");
      assert.equal(options.redirect,"error");
      assert.equal(options.headers.Authorization,"Bearer "+token);
      const body=JSON.parse(options.body);
      assert.match(body.query,/query MemoryCompletion/);
      calls.push(body.variables);
      return Response.json({data:{issue:respond(body.variables,calls.length)}});
    },...opts});
  return {client,calls};
}
test("completed issue and exact linked merged PR satisfy executor evidence",async()=>{
  const {client,calls}=fixture();
  assert.deepEqual(await client.getIssue("ABR-59"),{
    id:"ABR-59",statusType:"completed",repositoryId:repo,headSha:sha});
  assert.equal(calls.length,2);
  assert.equal((await client.getIssue(uuid)).id,uuid);
});
test("rejects incomplete, archived, wrong team and mismatched issue",async()=>{
  for(const patch of [
    {state:{type:"started"}},{archivedAt:"2026-11-20T00:00:00Z"},
    {team:{id:"other"}},{identifier:"ABR-60"},{completedAt:null},
  ]) await assert.rejects(fixture({respond:()=>({...issue,...patch})}).client.getIssue("ABR-59"),/unavailable/);
});
test("requires exact PR attachment and independently verified head",async()=>{
  for(const wrong of ["https://github.com/"+repo+"/pull/260",url+"/files",url+"?fake=1"]){
    await assert.rejects(fixture({respond:()=>({...issue,attachments:{
      ...issue.attachments,nodes:[{url:wrong}]}})}).client.getIssue("ABR-59"),/unavailable/);
  }
  for(const patch of [{merged:false},{head:{...pr.head,sha:"b".repeat(40)}},{number:260}]){
    await assert.rejects(fixture({github:{getPullRequest:async()=>({...pr,...patch})}}).client.getIssue("ABR-59"),/unavailable/);
  }
});
test("paginates both checks; refuses removed association and reopened issue",async()=>{
  const {client,calls}=fixture({respond:({after})=>({...issue,attachments:after?
    issue.attachments:{nodes:[{url:"other"}],pageInfo:{hasNextPage:true,endCursor:"next"}}})});
  await client.getIssue("ABR-59");
  assert.deepEqual(calls.map(c=>c.after),[null,"next",null,"next"]);
  for(const patch of [{state:{type:"started"}},{attachments:{...issue.attachments,nodes:[]}}]){
    await assert.rejects(fixture({respond:(_,n)=>n===1?issue:{...issue,...patch}}).client.getIssue("ABR-59"),/unavailable/);
  }
});
test("rejects repeated cursors, invalid inputs and GraphQL partial errors",async()=>{
  await assert.rejects(fixture({respond:()=>({...issue,attachments:{nodes:[{url}],
    pageInfo:{hasNextPage:true,endCursor:"loop"}}})}).client.getIssue("ABR-59"),/unavailable/);
  const {client,calls}=fixture();
  await assert.rejects(client.getIssue("../bad"),/unavailable/);
  assert.equal(calls.length,0);
  await assert.rejects(fixture({fetchImpl:async()=>Response.json({data:{issue},errors:[{message:"partial"}]})}).client.getIssue("ABR-59"),/unavailable/);
});
test("credential exceptions never leak and oversized streams are cancelled",async()=>{
  await assert.rejects(fixture({tokenProvider:async()=>{throw Error(token)}}).client.getIssue("ABR-59"),
    error=>error.code==="ELINEAR_COMPLETION_DENIED"&&!error.message.includes(token));
  let cancelled=false;
  const {client}=fixture({fetchImpl:async()=>new Response(new ReadableStream({
    pull(c){c.enqueue(new Uint8Array(70000))},cancel(){cancelled=true}
  }))});
  await assert.rejects(client.getIssue("ABR-59"),/unavailable/);
  assert.equal(cancelled,true);
});
