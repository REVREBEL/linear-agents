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

test("accepted root promotion hint preserves canonical admission file",async()=>{
 const os=await import("node:os"), fs=await import("node:fs/promises"), path=await import("node:path");
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-hint-"));
 try{
   const task=path.join(root,".linear-agent","projects","project","inbox","job.json");
   await fs.mkdir(path.dirname(task),{recursive:true});await fs.writeFile(task,'{"task":"approved"}');
   const issueId="dcedfdda-3793-4c5f-aa63-703897e9618b";
   const req=Readable.from([Buffer.from(JSON.stringify({issueId}))]);req.method="POST";
   req.headers={authorization:"Bearer bridge-key"};
   const response={writeHead(code){this.code=code;},end(body){this.data=JSON.parse(body);}};
   const transitions=[],events=[];
   const route=createIssueCompletionRoute({sharedSecret:"bridge-key",
     jobStore:{async findByIssueId(id){assert.equal(id,issueId);return[{key:"mock:delivery",state:"awaiting_external",taskFile:task}]},
       async transition(...args){transitions.push(args)}},
     cleanupMacTrae:async()=>{throw Error("unexpected remote cleanup")},
     onIssueCompletionHint:async scope=>{
       events.push(scope);
       assert.equal(await fs.readFile(task,"utf8"),'{"task":"approved"}');
       return {status:"accepted",jobKey:"mock:delivery"};
     }});
   assert.equal(await route(req,response,{url:new URL("http://local/issue-completed")}),true);
   assert.equal(response.code,200);
   assert.deepEqual(response.data,{ok:true,issueId,cleaned:0,memoryVerificationPending:true,retained:1});
   assert.deepEqual(events,[{issueId}]);
   assert.equal(transitions.length,1);
   assert.equal(transitions[0][0],"mock:delivery");
   assert.equal(transitions[0][2].memoryVerificationPending,true);
   assert.equal(await fs.readFile(task,"utf8"),'{"task":"approved"}');
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test("ordinary cleanup proceeds when operator denies or host is missing",async()=>{
 const os=await import("node:os"),fs=await import("node:fs/promises"),path=await import("node:path");
 for(const hint of [undefined,async()=>({status:"denied"})]){
   const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-clean-"));
   try{
     const file=path.join(root,".linear-agent","projects","p","inbox","job.json");
     await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,"{}");
     const req=Readable.from([Buffer.from('{"issueId":"dcedfdda-3793-4c5f-aa63-703897e9618b"}')]);
     req.method="POST";req.headers={authorization:"Bearer bridge-key"};
     const res={writeHead(code){this.code=code},end(body){this.data=JSON.parse(body)}};
     const transitions=[];
     const route=createIssueCompletionRoute({sharedSecret:"bridge-key",
       jobStore:{async findByIssueId(id){assert.equal(id,"dcedfdda-3793-4c5f-aa63-703897e9618b");return[{key:"mock:delivery",state:"completed",taskFile:file}]},
         async transition(key,state,metadata){transitions.push({key,state,metadata})}},
       cleanupMacTrae:async()=>{},onIssueCompletionHint:hint});
     await route(req,res,{url:new URL("http://local/issue-completed")});
     assert.equal(res.code,200);assert.equal(res.data.cleaned,1);
     assert.equal(res.data.memoryVerificationPending,undefined);
     assert.equal(transitions.length,1);
     await assert.rejects(fs.access(file),error=>error.code==="ENOENT");
   }finally{await fs.rm(root,{recursive:true,force:true})}
 }
});

test("root-accepted retention survives later duplicate callbacks, timeout and feature disable",async()=>{
 const os=await import("node:os"),fs=await import("node:fs/promises"),path=await import("node:path");
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-retention-replay-"));
 try{
   const file=path.join(root,".linear-agent","projects","project","inbox","job.json");
   await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,"verified original");
   const issueId="dcedfdda-3793-4c5f-aa63-703897e9618b";
   const record={key:"mock:authentic-delivery",state:"awaiting_external",taskFile:file};
   let accepts=0,writes=0;
   const store={
     async findByIssueId(id){assert.equal(id,issueId);return[structuredClone(record)]},
     async transition(key,state,patch){
       assert.equal(key,record.key);assert.equal(state,record.state);
       Object.assign(record,patch);writes++;
     }
   };
   const callbacks=[async()=>{accepts++;return {status:"accepted",jobKey:record.key}},
     async()=>{throw Error("duplicate in progress")},
     async()=>({status:"denied"}),undefined];
   for(let step=0;step<callbacks.length;step++){
     const request=Readable.from([Buffer.from(JSON.stringify({issueId}))]);
     request.method="POST";request.headers={authorization:"Bearer bridge-key"};
     const response={writeHead(status){this.status=status},end(body){this.data=JSON.parse(body)}};
     const route=createIssueCompletionRoute({sharedSecret:"bridge-key",jobStore:store,
       cleanupMacTrae:async()=>{throw Error("unexpected remote cleanup")},
       onIssueCompletionHint:callbacks[step]});
     await route(request,response,{url:new URL("http://local/issue-completed")});
     assert.equal(response.status,200);
     assert.deepEqual(response.data,{ok:true,issueId,cleaned:0,memoryVerificationPending:true,retained:1});
     assert.equal(record.memoryVerificationPending,true);
     assert.equal(await fs.readFile(file,"utf8"),"verified original");
   }
   assert.equal(accepts,1);
   assert.equal(writes,1,"duplicate callbacks must not rewrite or requeue accepted intents");
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test("failed durable retention persistence never deletes the original task",async()=>{
 const os=await import("node:os"),fs=await import("node:fs/promises"),path=await import("node:path");
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-retention-error-"));
 try{
   const file=path.join(root,".linear-agent","projects","project","inbox","job.json");
   await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,"original");
   const req=Readable.from([Buffer.from('{"issueId":"dcedfdda-3793-4c5f-aa63-703897e9618b"}')]);
   req.method="POST";req.headers={authorization:"Bearer bridge-key"};
   const route=createIssueCompletionRoute({sharedSecret:"bridge-key",
     jobStore:{async findByIssueId(id){assert.equal(id,"dcedfdda-3793-4c5f-aa63-703897e9618b");return [{key:"mock:job",state:"awaiting_external",taskFile:file}]},
       async transition(){throw Error("disk unavailable")}},
     cleanupMacTrae:async()=>{},
     onIssueCompletionHint:async()=>({status:"accepted",jobKey:"mock:job"})});
   const response={writeHead(){},end(){}};
   await assert.rejects(route(req,response,{url:new URL("http://local/issue-completed")}),/disk unavailable/);
   assert.equal(await fs.readFile(file,"utf8"),"original");
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test("root-approved job key retains only its own task when an issue has other deliveries",async()=>{
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path");
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-exact-key-"));
 try{
   const issueId="dcedfdda-3793-4c5f-aa63-703897e9618b";
   const dir=path.join(root,".linear-agent","projects","project","inbox");
   await fs.mkdir(dir,{recursive:true});
   const pinned=path.join(dir,"approved.json"),other=path.join(dir,"unrelated.json");
   await fs.writeFile(pinned,"approved");await fs.writeFile(other,"other");
   const records=[{key:"mock:pinned",state:"awaiting_external",taskFile:pinned},
     {key:"mock:unrelated",state:"completed",taskFile:other}];
   const saved=[];
   const req=Readable.from([Buffer.from(JSON.stringify({issueId}))]);
   req.method="POST";req.headers={authorization:"Bearer bridge-key"};
   const response={writeHead(code){this.code=code},end(data){this.payload=JSON.parse(data)}};
   const handler=createIssueCompletionRoute({sharedSecret:"bridge-key",
     jobStore:{async findByIssueId(id){assert.equal(id,issueId);return records},
       async transition(key,state,updates){saved.push({key,state,updates})}},
     cleanupMacTrae:async()=>{},
     onIssueCompletionHint:async()=>({status:"accepted",jobKey:"mock:pinned"})});
   await handler(req,response,{url:new URL("http://local/issue-completed")});
   assert.equal(response.code,200);
   assert.deepEqual(response.payload,{ok:true,issueId,cleaned:1,memoryVerificationPending:true,retained:1});
   assert.equal(await fs.readFile(pinned,"utf8"),"approved");
   await assert.rejects(fs.access(other),error=>error.code==="ENOENT");
   assert.deepEqual(saved.map(x=>x.key),["mock:pinned","mock:unrelated"]);
   assert.equal(saved[0].updates.memoryVerificationPending,true);
   assert.ok(saved[1].updates.inboxClearedAt);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test("uncertain first response retains admission proof until reconciliation",async()=>{
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path");
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-first-timeout-"));
 try{
   const issueId="dcedfdda-3793-4c5f-aa63-703897e9618b";
   const file=path.join(root,".linear-agent","projects","project","inbox","job.json");
   await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,"original");
   const record={key:"mock:canonical",state:"awaiting_external",taskFile:file};
   const handler=createIssueCompletionRoute({sharedSecret:"bridge-key",
     jobStore:{async findByIssueId(id){assert.equal(id,issueId);return [record]},
       async transition(key,state,metadata){assert.equal(key,record.key);Object.assign(record,metadata)}},
     cleanupMacTrae:async()=>{},
     onIssueCompletionHint:async()=>{throw Error("network timeout after possible enqueue")}});
   const req=Readable.from([Buffer.from(JSON.stringify({issueId}))]);
   req.method="POST";req.headers={authorization:"Bearer bridge-key"};
   const response={writeHead(code){this.code=code},end(data){this.body=JSON.parse(data)}};
   await handler(req,response,{url:new URL("http://local/issue-completed")});
   assert.equal(response.code,200);
   assert.deepEqual(response.body,{ok:true,issueId,cleaned:0,memoryVerificationPending:true,retained:1});
   assert.equal(record.memoryVerificationPending,true);
   assert.equal(await fs.readFile(file,"utf8"),"original");
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
