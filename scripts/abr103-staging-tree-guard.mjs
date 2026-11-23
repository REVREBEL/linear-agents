// ABR-103 non-production staging guard. The caller must launch Bubblewrap
// detached with --unshare-pid and --die-with-parent. No publication authority.
const deny=()=>Error('ABR103_STAGING_SUPERVISION_DENIED');
export function guardStagingProcessTree(child,{timeoutMs=15000,killGroup=process.kill}={}){
  if(!child||!Number.isSafeInteger(child.pid)||child.pid<=1||
    child.pid===process.pid||typeof child.once!=='function'||
    !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw deny();
  let completed=false,timedOut=false,killed=false;
  function terminate(){
    if(killed)return;
    killed=true;
    // The whole detached Linux process group is always terminated, not just
    // the direct Bubblewrap parent. Unknown/expired trees never run on.
    try{killGroup(-child.pid,'SIGKILL')}catch{}
    try{child.kill('SIGKILL')}catch{}
  }
  const timer=setTimeout(()=>{timedOut=true;terminate()},timeoutMs);
  timer.unref?.();
  child.once('close',()=>{
    completed=true;
    clearTimeout(timer);
    terminate(); // handles descendants that outlived their direct parent
  });
  child.once('error',()=>{
    completed=true;
    clearTimeout(timer);
    terminate();
  });
  return Object.freeze({
    terminate,
    status:()=>Object.freeze({completed,timedOut,terminated:killed})
  });
}
