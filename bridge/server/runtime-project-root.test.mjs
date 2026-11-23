import test from "node:test";
import assert from "node:assert/strict";
import {resolveBridgeProjectDirectory} from "./runtime-project-root.mjs";

const code="/var/lib/bridge-runtime/linear-agent-bridge";
const data="/home/bridge/agent-bridge/linear-agent-bridge";
test("sealed source path stays separate from operator-owned runtime data",()=>{
  assert.equal(resolveBridgeProjectDirectory(code),code);
  assert.equal(resolveBridgeProjectDirectory(code,data),data);
  assert.equal(resolveBridgeProjectDirectory(code,""),code);
});
test("relative, traversing and control-character runtime paths are rejected",()=>{
  for(const bad of ["relative","../escape","/home/bridge/../root",
    "/home/bridge/./private","/home/bridge/data/","/",
    "/home/bridge/\nprivate",null,12]){
    assert.throws(()=>resolveBridgeProjectDirectory(code,bad),/Invalid runtime project directory/);
  }
  assert.throws(()=>resolveBridgeProjectDirectory("relative",data),/Invalid source project directory/);
});
