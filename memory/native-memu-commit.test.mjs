import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { commitMemuInDisposableDatabase } from "./native-memu-commit.mjs";
const payload = { user:{user_id:"u",agent_id:"a"},resource:[],
  recall_files:[{name:"verified",track:"memory",description:"test",content:"verified outcome"}] };
async function fixture(run) {
  const root=await mkdtemp(path.join(os.tmpdir(),"abr59-native-"));
  try { return await run(path.join(root,"memory.sqlite3")); }
  finally { await rm(root,{recursive:true,force:true}); }
}
function stubSpawn(callback) {
  return (binary,args,opts) => {
    callback(binary,args,opts);
    const child=new EventEmitter();
    child.stdout=new PassThrough();
    child.stderr=new PassThrough();
    child.stdin=new PassThrough();
    child.kill=()=>true;
    let input="";
    child.stdin.on("data", c=>input+=String(c));
    child.stdin.on("finish",()=>{
      assert.deepEqual(JSON.parse(input),payload);
      setImmediate(()=>{
        child.stdout.end(JSON.stringify({recall_files:[{name:"verified"}],resources:[]}));
        child.emit("close",0);
      });
    });
    return child;
  };
}
test("native CLI runs only with disposable SQLite and bounded environment",async()=>{
  await fixture(async databasePath=>{
    let calls=0;
    const result=await commitMemuInDisposableDatabase(payload,{
      databasePath,configPath:"/home/bridge/.memu/config.env",
      runtimeLoader:async()=>({binary:"/opt/agents/memu/.venv/bin/memu",env:{
        MEMU_DB:"postgresql://production-untrusted",MEMU_API_KEY:"hidden",
        MEMU_BASE_URL:"http://127.0.0.1:11434/v1" }}),
      spawnImpl:stubSpawn((binary,args,opts)=>{
        calls++;
        assert.equal(binary,"/opt/agents/memu/.venv/bin/memu");
        assert.deepEqual(args,["commit","-","--json"]);
        assert.equal(opts.shell,false);
        assert.equal(opts.env.MEMU_DB,databasePath);
        assert.equal(opts.env.MEMU_API_KEY,"hidden");
      }),
    });
    assert.equal(calls,1);
    assert.equal(result.recall_files[0].name,"verified");
  });
});
test("native adapter rejects production DB paths and oversized unsafe input before CLI",async()=>{
  await fixture(async databasePath=>{
    for(const pathOverride of [
      "/home/bridge/agent_memory.sqlite3","/var/lib/memu/memory.sqlite3",
      "/tmp/../var/evil.sqlite3","postgresql://127.0.0.1/agent_memory",
    ]) await assert.rejects(commitMemuInDisposableDatabase(payload,{
      databasePath:pathOverride,spawnImpl:()=>{throw Error("must not spawn");},
    }),/disposable SQLite/);
    await assert.rejects(commitMemuInDisposableDatabase({
      ...payload,recall_files:[...payload.recall_files,...payload.recall_files],
    },{databasePath}),/payload is not approved/);
  });
});
test("CLI spawn failure is redacted and cannot reveal secrets",async()=>{
  await fixture(async databasePath=>{
    await assert.rejects(commitMemuInDisposableDatabase(payload,{
      databasePath,runtimeLoader:async()=>({binary:"/opt/agents/memu/.venv/bin/memu",
        env:{MEMU_API_KEY:"sensitive-api-secret"}}),
      spawnImpl:()=>{throw Error("sensitive-api-secret");},
    }),error=>!error.message.includes("sensitive") && /failed to spawn/.test(error.message));
  });
});

test("existing database and symlinked disposable targets are refused before spawning",async()=>{
  await fixture(async databasePath=>{
    const {writeFile,symlink,unlink}=await import("node:fs/promises");
    let invoked=0;
    const options={databasePath,spawnImpl:()=>{invoked++;throw Error("unexpected");}};
    await writeFile(databasePath,"existing");
    await assert.rejects(commitMemuInDisposableDatabase(payload,options),/must not already exist/);
    await unlink(databasePath);
    const target=path.join(path.dirname(databasePath),"another.sqlite3");
    await writeFile(target,"existing");
    await symlink(target,databasePath);
    await assert.rejects(commitMemuInDisposableDatabase(payload,options),/must not already exist/);
    assert.equal(invoked,0);
  });
});
