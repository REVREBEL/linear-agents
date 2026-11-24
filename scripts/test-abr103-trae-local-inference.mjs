import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTraeTrajectory,assertTraeStagingIdentity,runTraeLocalCanary} from './abr103-trae-local-inference.mjs';

const model='qwen3.5:9b-opencode';
const response={content:'Task completed',model,tool_calls:null};
const fixture={success:true,provider:'ollama',model,
  llm_interactions:[{provider:'ollama',model,response}],
  agent_steps:[{state:'completed',error:null,llm_response:response,
    tool_calls:null,tool_results:null}]};
test('ABR-103 accepts completed Trae Ollama inference with an actual model response',()=>{
  assert.equal(verifyTraeTrajectory(fixture),true);
});
test('ABR-103 rejects missing, empty and failed model responses or agent steps',()=>{
  for(const invalid of [
    {success:false},{provider:'openrouter'},{model:'not-local'},
    {llm_interactions:[]},{agent_steps:[]},{agent_steps:[{},{},{}]},
    {llm_interactions:[{provider:'ollama',model,response:null}]},
    {llm_interactions:[{provider:'ollama',model,response:{model,content:''}}]},
    {llm_interactions:[{provider:'openai',model,response}]},
    {agent_steps:[{state:'completed',llm_response:null}]},
    {agent_steps:[{state:'error',llm_response:response}]},
    {agent_steps:[{state:'completed',error:'model failed',llm_response:response}]},
    {agent_steps:[{state:'completed',llm_response:{model,content:''}}]},
    {agent_steps:[{state:'completed',llm_response:response,
      tool_results:[{success:false,error:'failed'}]}]}
  ])assert.equal(verifyTraeTrajectory({...fixture,...invalid}),false,
    'must reject '+JSON.stringify(invalid));
});
test('ABR-103 accepts a real task_done tool response and rejects empty tool calls',()=>{
  const tool={name:'task_done',call_id:'actual-call',arguments:{}};
  const r={model,content:'',tool_calls:[tool]};
  assert.equal(verifyTraeTrajectory({...fixture,
    llm_interactions:[{provider:'ollama',model,response:r}],
    agent_steps:[{state:'completed',error:null,llm_response:r,
      tool_calls:[tool],tool_results:[{success:true,error:null}]}]}),true);
  assert.equal(verifyTraeTrajectory({...fixture,
    llm_interactions:[{provider:'ollama',model,response:{model,content:'',tool_calls:[]}}]}),false);
});
test('ABR-103 non-root gate verifies both accepted and denied identities',async()=>{
  for(const uid of [1,994,65534])
    assert.equal(assertTraeStagingIdentity({uid,platform:'linux'}),true);
  for(const candidate of [
    {uid:0,platform:'linux'},{uid:undefined,platform:'linux'},
    {uid:-1,platform:'linux'},{uid:994,platform:'darwin'}])
    assert.throws(()=>assertTraeStagingIdentity(candidate),/ABR103_NONROOT_REQUIRED/);
  if(process.getuid?.()===0)
    await assert.rejects(runTraeLocalCanary(),/ABR103_NONROOT_REQUIRED/);
  else
    assert.equal(assertTraeStagingIdentity({
      uid:process.getuid?.(),platform:process.platform}),true);
});
