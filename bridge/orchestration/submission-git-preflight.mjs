// ABR-17 M2 — read-only Git readiness using the existing confined executor.
// Maps only separately approved, canonical workspace roots. Never calls a
// caller-supplied command, remote URL or working directory.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createSandboxRunner } from '../agent/mcp-host-agent/sandbox-runner.mjs';

const SHA=/^[a-f0-9]{40}$/;
const REF=/^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/;
const validRef=ref=>typeof ref==='string'&&REF.test(ref)&&!ref.includes('..')&&!ref.includes('//')&&!ref.endsWith('/')&&!ref.endsWith('.lock');
const deny=()=>Error('SUBMISSION_GIT_PREFLIGHT_DENIED');
const FLAGS=['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',
  '-c','core.pager=cat','-c','submodule.recurse=false','-c','diff.external='];
export function createSubmissionGitPreflight({projectsRoot,workspaces,githubBroker,
  expectedUid=process.getuid?.(),allowRootForIsolatedTests=false}={}){
  if(!githubBroker?.forScope||!Array.isArray(workspaces)||!workspaces.length)throw deny();
  const roots=new Map(),runnerRoots={};
  for(const [index,entry] of workspaces.entries()){
    if(!entry||typeof entry.repository!=='string'||typeof entry.root!=='string'||
       !path.isAbsolute(entry.root)||!Array.isArray(entry.requiredChecks)||
       !entry.requiredChecks.length||entry.requiredChecks.some(c=>!c||
       typeof c.name!=='string'||!c.name||typeof c.appId!=='string'||!/^\d+$/.test(c.appId)))throw deny();
    const canonical=realpathSync(entry.root),id='workspace-'+index;
    if(canonical!==entry.root||roots.has(canonical)||!statSync(canonical).isDirectory())throw deny();
    roots.set(canonical,Object.freeze({id,repository:entry.repository,requiredChecks:Object.freeze(
      entry.requiredChecks.map(c=>Object.freeze({name:c.name,appId:c.appId})))}));
    runnerRoots[id]=canonical;
  }
  const runner=createSandboxRunner({projectsRoot,workspaces:runnerRoots,expectedUid,
    allowRootForIsolatedTests,maxDurationMs:6000});
  async function git(id,args){
    const result=await runner.spawnCommand({workspaceId:id,program:'git',
      args:[...FLAGS,...args],write:false},{durationMs:6000}).completion;
    if(result.exitCode!==0||result.stdoutTruncated||result.stderrTruncated||
       result.stdout.includes('[REDACTED]'))throw deny();
    return result.stdout.trim();
  }
  async function inspect(scope){
    const cfg=roots.get(scope.repositoryRoot);
    if(!cfg||cfg.repository!==scope.repository||!validRef(scope.branch)||
       !validRef(scope.base)||scope.branch===scope.base||!SHA.test(scope.headSha))throw deny();
    const gitRead=args=>git(cfg.id,args);
    async function local(){
      const root=await gitRead(['rev-parse','--show-toplevel']);
      if(root!=='/workspace')throw deny();
      const branch=await gitRead(['symbolic-ref','--short','HEAD']);
      const head=await gitRead(['rev-parse','--verify','HEAD']);
      if(branch!==scope.branch||head!==scope.headSha)throw deny();
      const origin=await gitRead(['config','--local','--get-all','remote.origin.url']);
      if(!['https://github.com/'+scope.repository+'.git','https://github.com/'+scope.repository,
        'git@github.com:'+scope.repository+'.git','git@github.com:'+scope.repository].includes(origin))throw deny();
      const status=await gitRead(['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none']);
      if(status!=='')throw deny();
      // Reject unfinished merge, rebase, cherry-pick, revert and bisect.
      // Git dir is fixture-contained; linked worktrees with external metadata
      // fail closed until the separately audited host adapter supports them.
      const gitDir=await gitRead(['rev-parse','--absolute-git-dir']);
      if(gitDir!=='/workspace/.git')throw deny();
      const operations = await runner.spawnCommand({
        workspaceId:cfg.id,program:'python3',write:false,
        args:['-c','import os; names=("MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","REBASE_HEAD","BISECT_START","rebase-merge","rebase-apply","sequencer"); print("busy" if any(os.path.lexists("/workspace/.git/"+n) for n in names) else "clean")'],
      },{durationMs:6000}).completion;
      if(operations.exitCode!==0||operations.stdoutTruncated||
         operations.stdout.trim()!=='clean')throw deny();
    }
    await local();
    const github=await githubBroker.forScope(scope);
    if(github.mapping.repository!==scope.repository||github.mapping.appId!==scope.appId||
       github.mapping.installationId!==scope.installationId)throw deny();
    const remoteHead=await github.branchHead(scope.branch);
    const remoteBase=await github.branchHead(scope.base);
    if(remoteHead!==scope.headSha||!SHA.test(remoteBase)||remoteBase===remoteHead||
       !await github.checks(remoteHead,cfg.requiredChecks))throw deny();
    await local(); // re-read the local branch/cleanliness after remote I/O
    if(await github.branchHead(scope.branch)!==remoteHead)throw deny();
    return Object.freeze({verified:true,repository:scope.repository,repositoryRoot:scope.repositoryRoot,
      branch:scope.branch,base:scope.base,headSha:scope.headSha,remoteHeadSha:remoteHead,
      clean:true,detached:false,conflicts:false,checksPassed:true,
      installationId:scope.installationId,appId:scope.appId});
  }
  return Object.freeze({inspectGit:async({scope})=>{try{return await inspect(scope);}catch{throw deny();}}});
}
