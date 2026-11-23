#!/usr/bin/env node
// ABR-103: nonmutating native binary and private-FD sandbox evidence.
// This is NOT the production managed-submission supervisor: outbound networking
// is intentionally disabled and no provider credentials are made available.
import {spawn} from 'node:child_process';
import {openSync,closeSync,realpathSync,lstatSync,statSync,constants} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';

const cliPaths=Object.freeze({
  antigravity:'/opt/agents/gemini/bin/agy',
  'chatgpt-cli':'/opt/agent-tools/bin/opencode',
  trae:'/opt/agent-tools/trae-agent/.venv/bin/trae-cli'
});
const fixed=['--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc',
  '--die-with-parent','--new-session','--ro-bind','/usr','/usr',
  '--ro-bind','/bin','/bin','--ro-bind','/lib','/lib',
  '--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev',
  '--tmpfs','/tmp','--clearenv','--setenv','HOME','/tmp',
  '--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8'];
export function assertStagingWorkspace(root,location){
  const r=realpathSync(root),w=realpathSync(location);
  if(w===r||!w.startsWith(r+path.sep)||!statSync(w).isDirectory()||
    lstatSync(location).isSymbolicLink())throw Error('STAGING_WORKSPACE_DENIED');
  return w;
}
function start({workspace,root,agent,probe=false}){
  const cwd=assertStagingWorkspace(root,workspace);
  let fd=openSync(cwd,constants.O_DIRECTORY|constants.O_RDONLY|constants.O_NOFOLLOW);
  const actual=statSync('/proc/self/fd/'+fd),expected=statSync(cwd);
  if(actual.dev!==expected.dev||actual.ino!==expected.ino){
    closeSync(fd);throw Error('STAGING_WORKSPACE_CHANGED');
  }
  const mounts=['--ro-bind-fd','4','/workspace'];
  let command,args;
  if(probe){
    command='/usr/bin/python3';
    args=['-c',String.raw`import os,socket,json,subprocess
paths=["/etc/agent-bridge/bridge.env","/opt/credentials","/opt/agents/gemini/.gemini/oauth_creds.json","/var/lib/bridge-memory-authority/github-app.pem"]
child=subprocess.run(["/usr/bin/python3","-c","import os; os.write(3,b'M5_FD3_DESCENDANT_OK\\n')"],pass_fds=(3,),capture_output=True)
s=socket.socket();s.settimeout(0.25)
network=s.connect_ex(("127.0.0.1",8788))==0
print(json.dumps({"credentialVisible":any(os.path.exists(x) for x in paths),"networkReachable":network,"descendantExit":child.returncode,"workspaceVisible":os.path.isdir("/workspace")}))
`];
  }else if(agent==='trae'){
    // The installed Trae venv is editable and requires its package source,
    // interpreter and site-packages, but never its host config or auth.
    mounts.push('--dir','/opt','--dir','/opt/agent-tools',
      '--dir','/opt/agent-tools/trae-agent',
      '--ro-bind','/opt/agent-tools/trae-agent/.venv','/opt/agent-tools/trae-agent/.venv',
      '--ro-bind','/opt/agent-tools/trae-agent/.python','/opt/agent-tools/trae-agent/.python',
      '--ro-bind','/opt/agent-tools/trae-agent/trae_agent','/opt/agent-tools/trae-agent/trae_agent');
    command=cliPaths.trae;args=['--version'];
  }else{
    const original=cliPaths[agent];
    if(!original)throw Error('UNAPPROVED_PROVIDER');
    mounts.push('--ro-bind',original,'/native');
    command='/native';args=['--version'];
  }
  const spawnArgs=[...fixed,...mounts,'--chdir','/workspace','--',command,...args];
  let child;
  try{
    child=spawn('/usr/bin/bwrap',spawnArgs,{
      cwd:'/',detached:true,stdio:['ignore','pipe','pipe','pipe',fd],
      env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:'/tmp'}
    });
  }finally{closeSync(fd)}
  return child;
}
async function collect(child,{timeout=15000}={}){
  let stdout='',stderr='',fd3='';
  child.stdout.on('data',v=>{stdout=(stdout+v).slice(0,4096)});
  child.stderr.on('data',v=>{stderr=(stderr+v).slice(0,4096)});
  child.stdio[3].on('data',v=>{fd3=(fd3+v).slice(0,4096)});
  let timedOut=false;
  const kill=()=>{
    timedOut=true;
    try{process.kill(-child.pid,'SIGKILL')}catch{}
    try{child.kill('SIGKILL')}catch{}
  };
  const timer=setTimeout(kill,timeout);
  try{
    const [code,signal]=await once(child,'close');
    return {code,signal,stdout:stdout.trim(),stderr:stderr.trim(),fd3:fd3.trim(),timedOut};
  }catch(error){
    return {code:null,signal:null,stdout,stderr,fd3,timedOut,errorType:error.name};
  }finally{clearTimeout(timer)}
}
export async function runCanary({root=tmpdir()}={}){
  if(process.platform!=='linux'||process.getuid?.()===0)throw Error('NON_ROOT_ONLY');
  // A private, service-owned staging parent must be supplied on hosts where
  // the global /tmp is intentionally inaccessible to the bridge account.
  const parent=realpathSync(root);
  if(!statSync(parent).isDirectory())throw Error('STAGING_ROOT_DENIED');
  const work=await mkdtemp(path.join(parent,'abr103-native-'));
  const report={schemaVersion:1,mode:'network_denied_no_credentials',uid:process.getuid(),
    providers:{},probe:null,pass:false};
  try{
    const probe=await collect(start({root,workspace:work,probe:true}));
    let result;
    try{result=JSON.parse(probe.stdout)}catch{result={}}
    report.probe={pass:probe.code===0&&!probe.timedOut&&!result.credentialVisible&&
      !result.networkReachable&&result.workspaceVisible===true&&
      result.descendantExit===0&&probe.fd3==='M5_FD3_DESCENDANT_OK',
      credentialVisible:result.credentialVisible??null,
      networkReachable:result.networkReachable??null,
      descendantFd3:probe.fd3==='M5_FD3_DESCENDANT_OK',
      processExit:probe.code};
    for(const agent of Object.keys(cliPaths)){
      const output=await collect(start({root,workspace:work,agent}));
      report.providers[agent]={pass:output.code===0&&!output.timedOut&&
        !!output.stdout&&output.stderr.length===0,
        processExit:output.code,version:output.code===0?output.stdout.slice(0,120):null,
        failure:output.code===0?null:'native_binary_or_dependency_failed'};
    }
    report.pass=report.probe.pass&&Object.values(report.providers).every(x=>x.pass);
    return report;
  }finally{await rm(work,{recursive:true,force:true})}
}
if(process.argv[1]&&realpathSync(process.argv[1])===new URL(import.meta.url).pathname){
  const result=await runCanary();
  console.log(JSON.stringify(result,null,2));
  if(!result.pass)process.exitCode=1;
}
