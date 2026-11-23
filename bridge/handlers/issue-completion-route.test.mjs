import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createIssueCompletionRoute} from "./issue-completion-route.mjs";
async function dispatch({authorized=true,onIssueCompletionHint=async()=>{},records=[]}={}){
 const issueId="dcedfdda-3793-4c5f-aa63-703897e9618b";
 const req=Readable.from([Buffer.from(JSON.stringify({issueId}))]);
 req.method="POST";req.headers={authorization:authorized?"Bearer bridge-key":"Bearer invalid"};
 const response={writeHead(code){this.code=code;},end(body){this.payload=JSON.parse(body);}};
 let notified=0;
 const route=createIssueCompletionRoute({sharedSecret:"bridge-key",
   jobStore:{async findByIssueId(){return records;},async transition(){throw Error("unexpected transition");}},
   cleanupMacTrae:async()=>{},osxProjectsRoot:"/tmp",
   onIssueCompletionHint:async (...args)=>{notified++;await onIssueCompletionHint(...args);}});
 const handled=await route(req,response,{url:new URL("http://localhost/issue-completed")});
 return {handled,response,notified,issueId};
}
test("completion hint is emitted only after authentication, without PR or candidate data",async()=>{
 const events=[];
 const ok=await dispatch({onIssueCompletionHint:e=>events.push(e)});
 assert.equal(ok.handled,true);assert.equal(ok.response.code,200);
 assert.deepEqual(events,[{issueId:ok.issueId}]);
 const denied=await dispatch({authorized:false});
 assert.equal(denied.response.code,401);assert.equal(denied.notified,0);
});
test("memory hint denial never blocks confirmed issue cleanup response",async()=>{
 const result=await dispatch({onIssueCompletionHint:async()=>{throw Error("private cause");}});
 assert.equal(result.response.code,200);assert.equal(result.response.payload.cleaned,0);
});
