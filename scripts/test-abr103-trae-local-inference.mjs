import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTraeTrajectory,runTraeLocalCanary} from './abr103-trae-local-inference.mjs';

const fixture={success:true,provider:'ollama',model:'qwen3.5:9b-opencode',
  llm_interactions:[{provider:'ollama',model:'qwen3.5:9b-opencode'}],agent_steps:[{}]};
test('ABR-103 accepts actual Trae Ollama transcript with model response',()=>{
  assert.equal(verifyTraeTrajectory(fixture),true);
});
test('ABR-103 refuses empty/failed/foreign/overlong model transcripts',()=>{
  for(const change of [
    {success:false},{provider:'openrouter'},{model:'not-local'},
    {llm_interactions:[]},{agent_steps:[]},
    {llm_interactions:[{provider:'openai',model:'qwen3.5:9b-opencode'}]},
    {agent_steps:[{},{},{}]}
  ])assert.equal(verifyTraeTrajectory({...fixture,...change}),false);
});
test('ABR-103 local Trae canary requires non-root execution',async()=>{
  if(process.getuid?.()===0)
    await assert.rejects(runTraeLocalCanary(),/ABR103_NONROOT_REQUIRED/);
});
