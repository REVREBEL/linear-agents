#!/usr/bin/env node
// Explicit operator-only Mock Agent actions. Never runs automatically from webhook.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
const [action,...args]=process.argv.slice(2);
const find=key=>{const at=args.indexOf(key);return at<0?undefined:args[at+1];};
const jobPath=find("--job");
const issueInput=find("--issue");
const message=find("--message");
const confirmed=args.includes("--yes");
if (!["inspect","status","comment"].includes(action) || (!jobPath && !issueInput)) {
  console.error("Usage: npm run mock:agent -- inspect --job PATH | status --job PATH --to in-progress|in-review|completed [--yes] | comment --job PATH --message TEXT [--yes]");
  process.exit(2);
}
let job;
if(jobPath) job=JSON.parse(await fs.readFile(path.resolve(jobPath),"utf8"));
const origin=job?.payload?.original??{};
const issue=issueInput || origin?.agentSession?.issueId || origin?.agentSession?.issue?.id || origin?.data?.issueId || origin?.data?.issue?.id;
if(!issue) throw new Error("Issue ID missing from job. Supply --issue ID explicitly.");
const apiKey=process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN;
async function graphql(query,variables={}) {
  if(!apiKey) throw new Error("LINEAR_API_KEY or LINEAR_ACCESS_TOKEN required.");
  const response=await fetch("https://api.linear.app/graphql",{method:"POST",headers:{"Content-Type":"application/json",Authorization:apiKey},body:JSON.stringify({query,variables})});
  const result=await response.json();
  if(!response.ok || result.errors?.length) throw new Error(JSON.stringify(result.errors || result));
  return result.data;
}
const details=await graphql(`query($id:String!){issue(id:$id){id identifier title url state{name id} team{id name states{nodes{id name type}}}}}`,{id:issue});
if(!details.issue) throw new Error("Issue not found");
const item=details.issue;
console.log(JSON.stringify({issue:item.identifier,title:item.title,url:item.url,status:item.state?.name,job:jobPath||null},null,2));
if(action==="inspect")process.exit(0);
if(!confirmed) {
  const rl=createInterface({input:stdin,output:stdout});
  const answer=await rl.question(`Modify ${item.identifier} on Linear? Type YES: `);
  rl.close();
  if(answer!=="YES") {console.log("Cancelled");process.exit(0);}
}
if(action==="status") {
  const target=find("--to");
  const names={"in-progress":["in progress","started"],"in-review":["in review","review"],completed:["completed","done"]};
  if(!names[target]) throw new Error("--to must be in-progress, in-review, or completed");
  const matches=(item.team?.states?.nodes||[]).filter(x=>names[target].includes(x.name.toLowerCase()));
  if(matches.length!==1) throw new Error(`Expected one matching status, found ${matches.length}. Available: ${(item.team?.states?.nodes||[]).map(x=>x.name).join(", ")}`);
  const result=await graphql(`mutation($id:String!,$stateId:String!){issueUpdate(id:$id,input:{stateId:$stateId}){success}}`,{id:item.id,stateId:matches[0].id});
  if(!result.issueUpdate?.success)throw new Error("Linear rejected status update");
  console.log(`Updated ${item.identifier} to ${matches[0].name}`);
}else {
  if(!message?.trim())throw new Error("Provide --message TEXT");
  const result=await graphql(`mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}`,{input:{issueId:item.id,body:message}});
  if(!result.commentCreate?.success)throw new Error("Linear rejected comment");
  console.log(`Comment added to ${item.identifier}`);
}
