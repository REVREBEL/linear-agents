import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {guardStagingProcessTree} from './abr103-staging-tree-guard.mjs';

test('ABR-103 rejects invalid PID, child or unbounded lifecycle time',()=>{
  for(const child of [null,{pid:0,once(){}},{pid:process.pid,once(){}}])
    assert.throws(()=>guardStagingProcessTree(child),/ABR103_STAGING_SUPERVISION_DENIED/);
  assert.throws(()=>guardStagingProcessTree({pid:4321,once(){}},{timeoutMs:0}));
  assert.throws(()=>guardStagingProcessTree({pid:4321,once(){}},{timeoutMs:120001}));
});
test('ABR-103 expiry kills a detached launcher and inherited descendant',async()=>{
  const fixture=String.raw`import subprocess,sys,time
child=subprocess.Popen(["/usr/bin/sleep","60"])
print(child.pid,flush=True)
time.sleep(60)
`;
  const child=spawn('/usr/bin/python3',['-c',fixture],{
    detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}
  });
  const guard=guardStagingProcessTree(child,{timeoutMs:500});
  let text='';
  child.stdout.on('data',chunk=>text+=chunk.toString());
  await once(child.stdout,'data');
  const pid=Number(text.trim().split('\n')[0]);
  assert.ok(pid>1);
  await once(child,'close');
  assert.equal(guard.status().timedOut,true);
  assert.equal(guard.status().terminated,true);
  // A reaped or zombie process no longer executes. Zombie cleanup is
  // controlled by the system's PID 1, not by the staging canary.
  let running=false;
  try{
    const stat=readFileSync('/proc/'+pid+'/stat','utf8');
    const rest=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    running=rest[0]!=='Z'&&rest[0]!=='X';
  }catch(error){if(error.code!=='ENOENT')throw error}
  assert.equal(running,false,'descendant should no longer execute');
});
test('ABR-103 explicit cancellation kills the process group exactly once',async()=>{
  const child=spawn('/usr/bin/sleep',['60'],{
    detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}
  });
  const guard=guardStagingProcessTree(child,{timeoutMs:10000});
  guard.terminate();
  const [code,signal]=await once(child,'close');
  assert.equal(guard.status().terminated,true);
  assert.equal(guard.status().timedOut,false);
  assert.ok(signal==='SIGKILL'||code!==0);
});
