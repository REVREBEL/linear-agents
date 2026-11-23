import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {pathToFileURL,fileURLToPath} from "node:url";
const source=fileURLToPath(new URL("./verified-memory-host.mjs",import.meta.url));
const run=async handler=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-m14-ipc-"));
  const socket=path.join(root,"operator.sock");
  const sourceText=await fs.readFile(source,"utf8");
  const copy=path.join(root,"host.mjs");
  assert.ok(sourceText.includes('const SOCKET="/run/bridge-memory-authority/bridge.sock";'));
  await fs.writeFile(copy,sourceText.replace('const SOCKET="/run/bridge-memory-authority/bridge.sock";',
    'const SOCKET='+JSON.stringify(socket)+";"));
  const messages=[];
  const server=net.createServer(async stream=>{
    let input="";
    stream.on("data",data=>{
      input+=data.toString("utf8");
      if(!input.endsWith("\n"))return;
      try{
        const request=JSON.parse(input);
        messages.push(request);
        const result=handler(request);
        const bytes=Buffer.from(JSON.stringify(result)+"\n");
        // Split a multi-byte UTF-8 sequence to validate lossless parsing.
        const mid=Math.max(1,bytes.indexOf(Buffer.from([0xc3])));
        stream.write(bytes.subarray(0,mid+1));
        stream.end(bytes.subarray(mid+1));
      }catch{stream.end('{"ok":false,"error":"denied"}\n');}
    });
  });
  await new Promise((resolve,reject)=>server.listen(socket,error=>error?reject(error):resolve()));
  try{
    const {createVerifiedMemoryBridgeHost}=await import(pathToFileURL(copy).href);
    return await handler.test(await createVerifiedMemoryBridgeHost(),messages);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await fs.rm(root,{recursive:true,force:true});
  }
};
test("client sends only bounded operation metadata and decodes UTF-8 response",async()=>{
  const responder=request=>{
    if(request.op==="repo")return {ok:true,repositoryId:"REVREBEL/linear-agents"};
    if(request.op==="recall")return {ok:true,result:{
      schemaVersion:1,trust:"untrusted-reference-only",entries:[{
        content:"Verified café memory",sourceGitSha:"a".repeat(40)}]}};
    if(request.op==="complete")return {ok:true,accepted:true};
    return {ok:false,error:"denied"};
  };
  responder.test=async(host,events)=>{
    assert.equal(await host.repositoryIdForRoot("/approved/route"),"REVREBEL/linear-agents");
    const recall=await host.getApprovedScopedRecall({
      tenantId:"tenant",agentId:"qwen",repositoryRoot:"/approved/route",
      issueId:"ABR-59",jobKey:"qwen:delivery"});
    assert.equal(recall.entries[0].content,"Verified café memory");
    await host.notifyIssueCompleted({issueId:"ABR-59"});
    assert.deepEqual(events,[
      {op:"repo",repositoryRoot:"/approved/route"},
      {op:"recall",tenantId:"tenant",agentId:"qwen",repositoryRoot:"/approved/route",
       issueId:"ABR-59",jobKey:"qwen:delivery"},
      {op:"complete",issueId:"ABR-59"},
    ]);
  };
  await run(responder);
});
test("client never exposes rejected operator data or accepts denial",async()=>{
  const responder=()=>({ok:false,error:"denied"});
  responder.test=async host=>{
    await assert.rejects(host.repositoryIdForRoot("/approved/route"),/unavailable/);
    await assert.rejects(host.notifyIssueCompleted({issueId:"ABR-59"}),/unavailable/);
  };
  await run(responder);
});
