#!/usr/bin/env node
// ABR-103 Trae read-only Ollama inference canary, separate from managed launch.
// Explicit loopback access makes this a model functional probe, NOT sandbox
// egress approval. No GitHub, Linear, external credentials or editing tools.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {guardStagingProcessTree} from './abr103-staging-tree-guard.mjs';

const BASE='/opt/state/agent-bridge/m5-provider-homes/trae';
const EXEC='/opt/agent-tools/trae-agent/.venv/bin/trae-cli';
const MODEL='qwen3.5:9b-opencode';
const PROVIDER='ollama';
const CONFIG=[
  'model_providers:',
  '  ollama:',
  '    api_key: ollama',
  '    provider: ollama',
  '    base_url: http://127.0.0.1:11434/v1',
  'models:',
  '  local_probe:',
  '    model_provider: ollama',
  '    model: '+MODEL,
  '    temperature: 0.1',
  '    top_p: 1',
  '    top_k: 0',
  '    max_retries: 0',
  '    max_tokens: 48',
  '    parallel_tool_calls: false',
  'agents:',
  '  trae_agent:',
  '    enable_lakeview: false',
  '    model: local_probe',
  '    max_steps: 2',
  '    tools:',
  '      - task_done',
  ''
].join('\n');

const meaningfulResponse=r=>!!r&&typeof r==='object'&&r.model===MODEL&&(
  (typeof r.content==='string'&&r.content.trim().length>0)||
  (Array.isArray(r.tool_calls)&&r.tool_calls.some(c=>c&&
    c.name==='task_done'&&typeof c.call_id==='string'&&c.call_id.length>0))
);
export function verifyTraeTrajectory(d){
  if(!d||d.success!==true||d.provider!==PROVIDER||d.model!==MODEL||
    !Array.isArray(d.llm_interactions)||d.llm_interactions.length<1||
    !Array.isArray(d.agent_steps)||d.agent_steps.length<1||
    d.agent_steps.length>2)return false;
  // Trae's trajectory_recorder.py records actual LLMResponse fields inside
  // each interaction and its paired completed step. Metadata alone is
  // never proof of inference, even when the top-level success flag is true.
  if(!d.llm_interactions.every(x=>x&&x.provider===PROVIDER&&
      x.model===MODEL&&meaningfulResponse(x.response)))return false;
  return d.agent_steps.every(x=>x&&x.state==='completed'&&
    !x.error&&meaningfulResponse(x.llm_response)&&
    (x.tool_calls==null||Array.isArray(x.tool_calls))&&
    (x.tool_results==null||Array.isArray(x.tool_results))&&
    !(x.tool_results||[]).some(result=>result?.success!==true))&&
    d.agent_steps.some(x=>x.llm_response);
}
export function assertTraeStagingIdentity({uid,platform}){
  if(platform!=='linux'||!Number.isSafeInteger(uid)||uid<=0)
    throw Error('ABR103_NONROOT_REQUIRED');
  return true;
}
export async function runTraeLocalCanary(){
  assertTraeStagingIdentity({uid:process.getuid?.(),platform:process.platform});
  if(realpathSync(BASE)!==BASE||!statSync(BASE).isDirectory()||
     statSync(BASE).uid!==process.getuid()||(statSync(BASE).mode&0o077))
    throw Error('ABR103_PRIVATE_STAGING_REQUIRED');
  const check=await fetch('http://127.0.0.1:11434/api/tags',
    {signal:AbortSignal.timeout(5000)});
  if(!check.ok||!(await check.json()).models?.some(x=>x.name===MODEL))
    throw Error('ABR103_LOCAL_MODEL_NOT_READY');
  const root=await mkdtemp(path.join(BASE,'probe-'));
  const config=path.join(root,'trae-staging.yaml');
  const workspace=path.join(root,'workspace');
  const trajectory=path.join(root,'trajectory.json');
  const result={schemaVersion:1,provider:PROVIDER,model:MODEL,
    nativeLaunch:false,validatedTrajectory:false,pass:false};
  try{
    await mkdir(workspace,{mode:0o700});
    await writeFile(config,CONFIG,{mode:0o600,flag:'wx'});
    // The only allowed task tool is task_done; no filesystem/edit/bash tools.
    const args=['run','--config-file',config,'--working-dir',workspace,
      '--trajectory-file',trajectory,'--console-type','simple','--max-steps','2',
      '--','Read-only local model connectivity probe. Do not read, create or edit any files. '+
        'Do not run shell tools. Complete this task without external side effects.'];
    const child=spawn(EXEC,args,{cwd:workspace,detached:true,
      stdio:['ignore','ignore','ignore'],env:{
        HOME:root,PATH:'/opt/agent-tools/trae-agent/.venv/bin:/usr/bin:/bin',
        OLLAMA_HOST:'http://127.0.0.1:11434',LANG:'C.UTF-8'
      }});
    let guard,spawned=false,spawnError=null;
    const completion=new Promise(resolve=>{
      child.once('error',error=>{spawnError=error;resolve({code:null})});
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    child.once('spawn',()=>{
      spawned=true;
      try{guard=guardStagingProcessTree(child,{timeoutMs:120000})}
      catch(error){spawnError=error;child.kill('SIGKILL')}
    });
    const outcome=await completion;
    result.nativeLaunch=spawned&&outcome.code===0&&!spawnError&&
      !guard?.status().timedOut;
    if(result.nativeLaunch){
      try{result.validatedTrajectory=verifyTraeTrajectory(JSON.parse(await readFile(trajectory,'utf8')))}
      catch{}
    }
    result.pass=result.nativeLaunch&&result.validatedTrajectory;
    return result;
  }finally{await rm(root,{recursive:true,force:true})}
}
if(process.argv[1]&&realpathSync(process.argv[1])===new URL(import.meta.url).pathname){
  const report=await runTraeLocalCanary();
  console.log(JSON.stringify(report,null,2));
  if(!report.pass)process.exitCode=1;
}
