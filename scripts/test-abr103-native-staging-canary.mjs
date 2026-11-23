import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertStagingWorkspace,runCanary,FD3_DESCENDANT_CODE} from './abr103-native-staging-canary.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('ABR-103 rejects a workspace outside its staging parent and its parent itself',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'abr103-parent-'));
  const sub=path.join(root,'approved');
  await mkdir(sub);
  t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal(assertStagingWorkspace(root,sub),sub);
  assert.throws(()=>assertStagingWorkspace(root,root),/STAGING_WORKSPACE_DENIED/);
  assert.throws(()=>assertStagingWorkspace(root,os.tmpdir()),/STAGING_WORKSPACE_DENIED/);
});
test('ABR-103 rejects symlinked staging workspace and non-directory',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'abr103-symlink-'));
  const sub=path.join(root,'approved'),link=path.join(root,'linked'),file=path.join(root,'file');
  await mkdir(sub);await symlink(sub,link);await writeFile(file,'not a directory');
  t.after(()=>rm(root,{recursive:true,force:true}));
  assert.throws(()=>assertStagingWorkspace(root,link),/STAGING_WORKSPACE_DENIED/);
  assert.throws(()=>assertStagingWorkspace(root,file));
});
test('ABR-103 cannot create an operator binding or run native canaries as root',async()=>{
  if(process.getuid?.()===0)
    await assert.rejects(runCanary(),/NON_ROOT_ONLY/);
  else
    assert.ok(process.getuid()>0);
});

test('ABR-103 exact descendant FD3 marker ends in one real newline',async()=>{
  const child=spawn('/usr/bin/python3',['-c',FD3_DESCENDANT_CODE],{
    stdio:['ignore','pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}
  });
  const chunks=[];child.stdio[3].on('data',value=>chunks.push(value));
  const [code]=await once(child,'close');
  assert.equal(code,0);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from('M5_FD3_DESCENDANT_OK\n','utf8'));
});
