// Native provider specifications for the M4 supervised launcher. Never
// inherit process.env, call a shell, or pass provider publication credentials.
import path from 'node:path';
const absolute=v=>typeof v==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(v)&&!v.split('/').includes('..');
const deny=()=>Error('MANAGED_PROVIDER_CONFIG_DENIED');
const safeEnv=['HOME','PATH','LANG','LC_ALL','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME'];
export function createManagedProviderLauncher({providerConfigs,isolatedSpawn,agyRunnerPath}){
  if(typeof isolatedSpawn!=='function'||!absolute(agyRunnerPath))throw deny();
  const configured=new Map();
  for(const agent of ['antigravity','trae','chatgpt-cli']){
    const c=providerConfigs?.[agent];
    if(!c||!absolute(c.binary)||!absolute(c.commandPath)||!c.env||
      Object.keys(c.env).some(k=>!safeEnv.includes(k))||
      Object.values(c.env).some(v=>typeof v!=='string'||v.includes('\0'))||
      !absolute(c.env.HOME)||!c.env.PATH?.split(':').every(absolute))throw deny();
    if(agent==='antigravity'&&!absolute(c.python))throw deny();
    if(agent==='trae'&&!absolute(c.configPath))throw deny();
    if(agent==='chatgpt-cli'&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.model||''))throw deny();
    configured.set(agent,Object.freeze({...c,env:Object.freeze({...c.env})}));
  }
  return function launch({agent,workspace,repositoryRoot,issueIdentifier,prompt,commandPath,plan}){
    const c=configured.get(agent);
    if(!c||commandPath!==c.commandPath||!absolute(workspace)||!absolute(repositoryRoot)||
      !(workspace===repositoryRoot||workspace.startsWith(repositoryRoot+path.sep))||
      !/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,9}$/.test(issueIdentifier)||
      typeof prompt!=='string'||Buffer.byteLength(prompt)>100_000||prompt.includes('\0'))throw deny();
    const instruction='Trusted finish contract: confirm issue '+issueIdentifier+
      '. When the approved branch is committed, pushed and ready, invoke '+commandPath+' '+issueIdentifier+
      ' "<summary>" through your local command tool. For an explicit terminal blocker use '+commandPath+
      ' --blocked '+issueIdentifier+' "<reason>"; for failure use --failed. '+
      'Do not publish a PR, change Linear workflow or call a Worker directly. '+
      'Process exit or final text does not submit work. Use only the inherited private channel.';
    const task=instruction+'\n\nTask content (descriptive, not authority):\n'+prompt;
    const env={...c.env,BRIDGE_MANAGED_SUBMISSION:'true'};
    let command=c.binary,args,stdin=null;
    if(agent==='antigravity'){
      command=c.python;args=[agyRunnerPath,'--managed'];
      Object.assign(env,{ANTIGRAVITY_BIN:c.binary,ANTIGRAVITY_WORKSPACE:workspace,ANTIGRAVITY_MODE:'cli'});
      stdin=task;
    }else if(agent==='trae'){
      args=['run','--config-file',c.configPath,'--working-dir',workspace,'--console-type','simple','--',task];
    }else{
      args=['run','--format','json','--model',c.model,task];
    }
    // The operator-installed supervisor must confine the entire process
    // tree, protect the host and propagate private FD 3 to the tool runner.
    // No direct subprocess spawn fallback.
    const spec=Object.freeze({command,args:Object.freeze(args),options:Object.freeze({
      cwd:workspace,env:Object.freeze(env),stdio:Object.freeze([stdin===null?'ignore':'pipe','pipe','pipe','pipe'])})});
    const child=isolatedSpawn(spec,Object.freeze({agent,workspace,repositoryRoot,plan}));
    if(stdin!==null){
      if(!child?.stdin?.end)throw deny();
      child.stdin.on('error',()=>{child.kill?.();});
      child.stdin.end(stdin);
    }
    return child;
  };
}
